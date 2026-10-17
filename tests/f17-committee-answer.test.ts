import { describe, expect, it } from "vitest"

/**
 * Audit F17, spec ruling 1: the committee answer contract. The answer must be exactly one JSON object of the shape the
 * committee-brain policy asks for, read by a strict reader so that what is graded is exactly what is shown: no code
 * fence or prose around it, no duplicate key (a later duplicate cannot hide an earlier claim), no `\u` escape (an
 * escape cannot carry text the response mask did not see), bounded depth and size; then a `.strict()` schema with
 * bounded sizes, so an extra key such as `"verified": true` breaks the contract. A refusal is a fixed reason code.
 *
 * The module is loaded dynamically, so this file reports each case as a failure (not an import error) before it exists.
 * Every citation is synthetic (2099) and every name invented.
 */

type Parsed = { ok: true; answer: unknown } | { ok: false; reason: string }
type Mod = {
  parseCommitteeAnswer: (text: string) => Parsed
  readStrictJson: (text: string) => { ok: true; value: unknown } | { ok: false; reason: string }
  COMMITTEE_ANSWER_LIMITS: Record<string, number>
  AUTHORITY_KINDS: readonly string[]
}

const load = async (): Promise<Mod> => (await import("@/platform/p1/committeeAnswer")) as unknown as Mod

const authority = (citation: string, extra: Record<string, unknown> = {}) => ({ kind: "judgment", citation, ...extra })
const answer = (claims: unknown[], extra: Record<string, unknown> = {}) => ({
  sections: [{ heading: "Bail", text: "The question is whether bail may be granted.", claims }],
  caveats: [],
  ...extra,
})
const claim = (statement: string, authorities: unknown[]) => ({ statement, authorities })
const json = (v: unknown) => JSON.stringify(v)

const GOOD = answer([claim("Bail is the rule and refusal the exception.", [authority("PLD 2099 SC 101", { pinpoint: "para 12" })])])

describe("audit F17: the committee answer contract (spec ruling 1)", () => {
  it("accepts the contract: English, Urdu, with surrounding whitespace, with an empty claim list and a statute authority", async () => {
    const { parseCommitteeAnswer } = await load()
    expect(parseCommitteeAnswer(json(GOOD))).toEqual({ ok: true, answer: GOOD })
    const urdu = {
      sections: [
        {
          heading: "ضمانت",
          text: "سوال یہ ہے کہ کیا ملزم کو ضمانت دی جا سکتی ہے۔",
          claims: [claim("ضمانت قاعدہ ہے اور انکار استثنا ہے۔", [authority("PLD 2099 SC 101")])],
        },
      ],
      caveats: ["یہ رائے حتمی نہیں ہے۔"],
    }
    expect(parseCommitteeAnswer(`\n  ${json(urdu)}\n\t`)).toEqual({ ok: true, answer: urdu })
    const noClaims = { sections: [{ heading: "Facts", text: "", claims: [] }], caveats: ["Nothing to cite."] }
    expect(parseCommitteeAnswer(json(noClaims))).toEqual({ ok: true, answer: noClaims })
    const statute = answer([claim("The limit is sixty days.", [{ kind: "statute", citation: "Section 5, Test Act 2099" }])])
    expect(parseCommitteeAnswer(json(statute))).toEqual({ ok: true, answer: statute })
  })

  it("decodes the simple escapes and keeps every other character as written", async () => {
    const { readStrictJson } = await load()
    expect(readStrictJson('{"a":"line\\nbreak \\"quoted\\" back\\\\slash \\/ tab\\t","b":[1,-2.5,3e2,true,false,null]}')).toEqual({
      ok: true,
      value: { a: 'line\nbreak "quoted" back\\slash / tab\t', b: [1, -2.5, 300, true, false, null] },
    })
  })

  it.each([
    ["a code fence", "```json\n" + json(GOOD) + "\n```", "not_json"],
    ["prose before", "Here is the answer: " + json(GOOD), "not_json"],
    ["prose after", json(GOOD) + " I hope this helps.", "not_json"],
    ["two objects", json(GOOD) + json(GOOD), "not_json"],
    ["truncated JSON", json(GOOD).slice(0, 60), "not_json"],
    ["a raw line break inside a string", '{"sections":"a\nb"}', "not_json"],
    ["single quotes", "{'sections': []}", "not_json"],
    ["a trailing comma", '{"sections":[],}', "not_json"],
    ["a leading zero", '{"sections":01}', "not_json"],
    ["an empty text", "", "not_json"],
    ["plain prose", "Bail is the rule and refusal the exception, as held in PLD 2099 SC 101.", "not_json"],
    ["an array root", "[]", "not_object"],
    ["a string root", '"PLD 2099 SC 101"', "not_object"],
    ["a null root", "null", "not_object"],
    ["a duplicate root key", '{"sections":[],"caveats":[],"sections":[]}', "duplicate_key"],
    ["a duplicate key in a section", '{"sections":[{"heading":"a","text":"","claims":[],"claims":[]}],"caveats":[]}', "duplicate_key"],
    ["a duplicate key in an authority", '{"sections":[{"heading":"a","text":"","claims":[{"statement":"s","authorities":[{"kind":"judgment","citation":"PLD 2099 SC 1","citation":"PLD 2099 SC 2"}]}]}],"caveats":[]}', "duplicate_key"],
    ["a \\u escape", '{"sections":[{"heading":"\\u0041li","text":"","claims":[]}],"caveats":[]}', "unicode_escape"],
    ["a \\u escape of a control character", '{"sections":[],"caveats":["\\u0000"]}', "unicode_escape"],
    ["nesting deeper than the contract", '{"sections":[[[[[[[[[1]]]]]]]]]}', "too_deep"],
  ])("refuses %s (%s)", async (_label, text, reason) => {
    const { parseCommitteeAnswer } = await load()
    expect(parseCommitteeAnswer(text)).toEqual({ ok: false, reason })
  })

  it("refuses a text over the size bound before reading it", async () => {
    const { parseCommitteeAnswer, COMMITTEE_ANSWER_LIMITS } = await load()
    const big = json(answer([claim("x".repeat(COMMITTEE_ANSWER_LIMITS.maxChars!), [])]))
    expect(parseCommitteeAnswer(big)).toEqual({ ok: false, reason: "too_long" })
  })

  const many = (n: number) => Array.from({ length: n }, (_, i) => authority(`PLD 2099 SC ${i + 1}`))
  it.each([
    ["an unknown authority key (a verification claim)", answer([claim("s", [authority("PLD 2099 SC 1", { verified: true })])])],
    ["an unknown claim key", answer([{ ...claim("s", []), status: "VERIFIED" }])],
    ["an unknown section key", { sections: [{ heading: "a", text: "", claims: [], grounded: true }], caveats: [] }],
    ["an unknown root key", answer([], { grounding: "grounded" })],
    ["a missing caveats list", { sections: [{ heading: "a", text: "", claims: [] }] }],
    ["a missing text", { sections: [{ heading: "a", claims: [] }], caveats: [] }],
    ["no section", { sections: [], caveats: [] }],
    ["an empty heading", { sections: [{ heading: "", text: "", claims: [] }], caveats: [] }],
    ["an unknown authority kind", answer([claim("s", [{ kind: "case", citation: "PLD 2099 SC 1" }])])],
    ["an empty citation", answer([claim("s", [authority("")])])],
    ["an empty pinpoint", answer([claim("s", [authority("PLD 2099 SC 1", { pinpoint: "" })])])],
    ["an empty statement", answer([claim("", [])])],
    ["a number for a string", answer([claim("s", [{ kind: "judgment", citation: 2099 }])])],
    ["too many authorities on one claim", answer([claim("s", many(11))])],
    ["too many sections", { sections: Array.from({ length: 21 }, () => ({ heading: "a", text: "", claims: [] })), caveats: [] }],
    ["too many claims in a section", answer(Array.from({ length: 31 }, () => claim("s", [])))],
    [
      "too many authorities in all",
      { sections: Array.from({ length: 3 }, () => ({ heading: "a", text: "", claims: Array.from({ length: 7 }, () => claim("s", many(10))) })), caveats: [] },
    ],
    ["too many caveats", answer([], { caveats: Array.from({ length: 21 }, () => "c") })],
    ["a citation over 300 characters", answer([claim("s", [authority("P".repeat(301))])])],
  ])("breaks the contract: %s", async (_label, value) => {
    const { parseCommitteeAnswer } = await load()
    expect(parseCommitteeAnswer(json(value))).toEqual({ ok: false, reason: "contract" })
  })

  it("reads `__proto__` as an ordinary key (refused by the contract) and never touches a prototype", async () => {
    const { parseCommitteeAnswer, readStrictJson } = await load()
    const text = '{"sections":[{"heading":"a","text":"","claims":[{"statement":"s","authorities":[{"kind":"judgment","citation":"PLD 2099 SC 1","__proto__":{"polluted":true}}]}]}],"caveats":[]}'
    expect(parseCommitteeAnswer(text)).toEqual({ ok: false, reason: "contract" })
    const read = readStrictJson('{"__proto__":{"polluted":true}}')
    expect(read.ok).toBe(true)
    expect(Object.keys((read as { value: object }).value)).toEqual(["__proto__"])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("names the four authority kinds", async () => {
    const { AUTHORITY_KINDS } = await load()
    expect([...AUTHORITY_KINDS]).toEqual(["judgment", "statute", "rule", "other"])
  })
})
