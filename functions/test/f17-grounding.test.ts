import { logger } from "firebase-functions"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AuthorityUnavailableError, EMPTY_AUTHORITY_STORE, InMemoryAuthorityStore, type AuthorityStore } from "../src/d4/authority"

/**
 * Audit F17, spec rulings 2 and 3: grounding a committee answer. Every cited authority (a claim's structured citation
 * and every citation the D4 extractor finds in the answer's prose) is resolved through the D4 gate's own steps
 * against the authority store, and the answer gets a status by the rules `f17.1`. Fixtures follow P4-13: the year
 * 2099, no real judgment, invented names only.
 *
 * The module is loaded dynamically, so this file reports each case as a failure before it exists.
 */

type Citation = { ref: string; kind: string; source: string; status: string; judgmentId: string | null }
type Grounding = {
  status: string
  rules: string
  policy: { policyId: string; version: string } | null
  claims: { total: number; supported: number }
  citations: Citation[]
  omitted: number
}
type Mod = {
  groundAnswer: (
    input: { text: string | undefined; policy: { policyId: string; version: string } | null; partyNames: readonly string[] },
    store: AuthorityStore,
    options?: { budgetMs?: number; now?: () => number }
  ) => Promise<Grounding>
  isAdvisory: (g: Grounding) => boolean
  GROUNDING_RULES_VERSION: string
  GROUNDING_BUDGET_MS: number
  MAX_GROUNDED_CITATIONS: number
}
const load = async (): Promise<Mod> => (await import("../src/p1/grounding")) as unknown as Mod

const POLICY = { policyId: "committee-brain", version: "f17.1" }

function corpus(): InMemoryAuthorityStore {
  const s = new InMemoryAuthorityStore()
  s.addJudgment("j-good", "PLD 2099 SC 101", "division")
  s.addJudgment("j-good-2", "2099 CLC 505", "single")
  s.addJudgment("j-old", "2099 SCMR 202", "division")
  s.addJudgment("j-larger", "PLD 2099 SC 303", "larger")
  s.addJudgment("j-pending", "2099 SCMR 404", "division")
  s.addTreatment("j-larger", "j-old", "overruled", "larger")
  s.addPendingOverruling("j-pending")
  return s
}

const auth = (citation: string, kind = "judgment") => ({ kind, citation })
const claim = (statement: string, ...authorities: Array<{ kind: string; citation: string }>) => ({ statement, authorities })
const answer = (claims: unknown[], text = "The question is whether bail may be granted.", caveats: string[] = []) =>
  JSON.stringify({ sections: [{ heading: "Bail", text, claims }], caveats })

const ground = async (text: string | undefined, store: AuthorityStore = corpus(), partyNames: string[] = [], options = {}) =>
  (await load()).groundAnswer({ text, policy: POLICY, partyNames }, store, options)

const unavailable: AuthorityStore = {
  findJudgment: async () => Promise.reject(new AuthorityUnavailableError("unreachable")),
  listTreatments: async () => Promise.reject(new AuthorityUnavailableError("unreachable")),
  getSectionAsAt: async () => Promise.reject(new AuthorityUnavailableError("unreachable")),
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("audit F17: grounding a committee answer (spec rulings 2 and 3)", () => {
  it("names its rules and budget, and passes the policy record through", async () => {
    const m = await load()
    expect(m.GROUNDING_RULES_VERSION).toBe("f17.2")
    expect(m.GROUNDING_BUDGET_MS).toBe(20_000)
    expect(m.MAX_GROUNDED_CITATIONS).toBe(100)
    const g = await ground(answer([claim("Bail is the rule.", auth("PLD 2099 SC 101"))]))
    expect(g.rules).toBe("f17.2")
    expect(g.policy).toEqual(POLICY)
  })

  it("no text (a blocked or failed call): not_assessed, nothing resolved", async () => {
    expect(await ground(undefined)).toEqual({ status: "not_assessed", rules: "f17.2", policy: POLICY, claims: { total: 0, supported: 0 }, citations: [], omitted: 0 })
  })

  it("every claim supported by a verified authority: grounded, not advisory", async () => {
    const m = await load()
    const g = await ground(answer([claim("Bail is the rule.", auth("PLD 2099 SC 101")), claim("Delay is a ground.", auth("2099 CLC 505"), auth("PLD 2099 Supreme Court 101"))]))
    expect(g).toEqual({
      status: "grounded",
      rules: "f17.2",
      policy: POLICY,
      claims: { total: 2, supported: 2 },
      citations: [
        { ref: "PLD 2099 SC 101", kind: "judgment", source: "claim", status: "VERIFIED", judgmentId: "j-good" },
        { ref: "2099 CLC 505", kind: "judgment", source: "claim", status: "VERIFIED", judgmentId: "j-good-2" },
      ],
      omitted: 0,
    })
    expect(m.isAdvisory(g)).toBe(false)
  })

  it("a fabricated authority: ungrounded, the citation UNVERIFIED (not found)", async () => {
    const g = await ground(answer([claim("The Supreme Court made bail a right.", auth("PLD 2099 SC 7777"))]))
    expect(g.status).toBe("ungrounded")
    expect(g.claims).toEqual({ total: 1, supported: 0 })
    expect(g.citations).toEqual([{ ref: "PLD 2099 SC 7777", kind: "judgment", source: "claim", status: "UNVERIFIED", judgmentId: null }])
  })

  it("an overruled authority: ungrounded, OVERRULED with its judgment id; an overruling pending review: PENDING_OVERRULING", async () => {
    const old = await ground(answer([claim("s", auth("2099 SCMR 202"))]))
    expect(old.status).toBe("ungrounded")
    expect(old.citations).toEqual([{ ref: "2099 SCMR 202", kind: "judgment", source: "claim", status: "OVERRULED", judgmentId: "j-old" }])
    const pending = await ground(answer([claim("s", auth("2099 SCMR 404"))]))
    expect(pending.status).toBe("ungrounded")
    expect(pending.citations).toEqual([{ ref: "2099 SCMR 404", kind: "judgment", source: "claim", status: "PENDING_OVERRULING", judgmentId: "j-pending" }])
  })

  it("one supported claim beside an unsupported one: partially_grounded, advisory", async () => {
    const m = await load()
    const fabricated = await ground(answer([claim("a", auth("PLD 2099 SC 101")), claim("b", auth("PLD 2099 SC 7777"))]))
    expect([fabricated.status, fabricated.claims]).toEqual(["partially_grounded", { total: 2, supported: 1 }])
    const bare = await ground(answer([claim("a", auth("PLD 2099 SC 101")), claim("b, which needs no authority")]))
    expect([bare.status, bare.claims]).toEqual(["partially_grounded", { total: 2, supported: 1 }])
    expect(m.isAdvisory(bare)).toBe(true)
  })

  it("no citation anywhere: not_assessed (F06), advisory", async () => {
    const m = await load()
    const g = await ground(answer([claim("The client should file within the period.")]))
    expect([g.status, g.claims, g.citations]).toEqual(["not_assessed", { total: 1, supported: 0 }, []])
    expect(m.isAdvisory(g)).toBe(true)
  })

  it("verified citations in prose but no claim: partially_grounded (nothing ties them to an assertion)", async () => {
    const g = await ground(answer([], "As held in PLD 2099 SC 101, bail is the rule."))
    expect(g.status).toBe("partially_grounded")
    expect(g.citations).toEqual([{ ref: "PLD 2099 SC 101", kind: "judgment", source: "text", status: "VERIFIED", judgmentId: "j-good" }])
  })

  it("a fabricated citation in prose beside supported claims makes the answer partially grounded, never grounded", async () => {
    const g = await ground(answer([claim("a", auth("PLD 2099 SC 101"))], "See also 2099 SCMR 9999."))
    expect(g.status).toBe("partially_grounded")
    expect(g.citations.map((c) => [c.ref, c.source, c.status])).toEqual([
      ["PLD 2099 SC 101", "claim", "VERIFIED"],
      ["2099 SCMR 9999", "text", "UNVERIFIED"],
    ])
  })

  it("de-duplicates by judgment: one entry for two spellings, `both` when cited in a claim and named in its statement", async () => {
    const g = await ground(answer([claim("As PLD 2099 Supreme Court 101 holds, bail is the rule.", auth("PLD 2099 SC 101"))]))
    expect(g.citations).toEqual([{ ref: "PLD 2099 SC 101", kind: "judgment", source: "both", status: "VERIFIED", judgmentId: "j-good" }])
    expect(g.status).toBe("grounded")
  })

  it("prose is read from every field but the citation: heading, text, statement, pinpoint and caveat", async () => {
    const text = JSON.stringify({
      sections: [{ heading: "On PLD 2099 SC 303", text: "", claims: [{ statement: "s", authorities: [{ kind: "judgment", citation: "PLD 2099 SC 101", pinpoint: "read with 2099 CLC 505" }] }] }],
      caveats: ["Compare 2099 SCMR 202."],
    })
    const g = await ground(text)
    expect(g.citations.map((c) => [c.ref, c.source])).toEqual([
      ["PLD 2099 SC 101", "claim"],
      ["PLD 2099 SC 303", "text"],
      ["2099 CLC 505", "text"],
      ["2099 SCMR 202", "text"],
    ])
    expect(g.status).toBe("partially_grounded")
  })

  it("a statute authority cannot be resolved by citation: UNVERIFIED, so its claim is not supported", async () => {
    const g = await ground(answer([claim("The limit is sixty days.", auth("Section 5, Test Act 2099", "statute"))]))
    expect(g.status).toBe("ungrounded")
    expect(g.citations).toEqual([{ ref: "Section 5, Test Act 2099", kind: "statute", source: "claim", status: "UNVERIFIED", judgmentId: null }])
  })

  // Review round (Codex P1 on PR #63, spec ruling R2a): only an authority declared `judgment` is resolved through the
  // judgment path. A report-style citation declared statute, rule or other is never looked up: UNVERIFIED, marked
  // `kindMismatch`, so its claim is never supported and the answer never grounded.
  it.each(["statute", "rule", "other"])("a report-style citation declared %s is never resolved as a judgment: UNVERIFIED, kindMismatch", async (kind) => {
    const lookups: string[] = []
    const base = corpus()
    const spy: AuthorityStore = {
      findJudgment: async (c) => (lookups.push(c), base.findJudgment(c)),
      listTreatments: (id) => base.listTreatments(id),
      getSectionAsAt: async () => "no_history",
    }
    const m = await load()
    const g = await ground(answer([claim("Bail is the rule.", auth("PLD 2099 Supreme Court 101", kind))]), spy)
    expect(g.status).toBe("ungrounded")
    expect(m.isAdvisory(g)).toBe(true)
    expect(g.claims).toEqual({ total: 1, supported: 0 })
    expect(g.citations).toEqual([{ ref: "PLD 2099 SC 101", kind, source: "claim", status: "UNVERIFIED", judgmentId: null, kindMismatch: true }])
    expect(lookups).toEqual([])
  })

  it("a free-text hit of a mislabelled citation verifies only itself: the claim stays unsupported", async () => {
    const g = await ground(answer([claim("As PLD 2099 SC 101 holds, bail is the rule.", auth("PLD 2099 SC 101", "statute"))]))
    expect(g.claims).toEqual({ total: 1, supported: 0 })
    expect(g.citations).toEqual([
      { ref: "PLD 2099 SC 101", kind: "statute", source: "claim", status: "UNVERIFIED", judgmentId: null, kindMismatch: true },
      { ref: "PLD 2099 SC 101", kind: "judgment", source: "text", status: "VERIFIED", judgmentId: "j-good" },
    ])
    expect(g.status).toBe("ungrounded")
  })

  it("the same judgment declared judgment in one claim and statute in another: only the first claim is supported", async () => {
    const g = await ground(answer([claim("a", auth("PLD 2099 SC 101")), claim("b", auth("PLD 2099 SC 101", "rule"))]))
    expect([g.status, g.claims]).toEqual(["partially_grounded", { total: 2, supported: 1 }])
    expect(g.citations).toEqual([
      { ref: "PLD 2099 SC 101", kind: "judgment", source: "claim", status: "VERIFIED", judgmentId: "j-good" },
      { ref: "PLD 2099 SC 101", kind: "rule", source: "claim", status: "UNVERIFIED", judgmentId: null, kindMismatch: true },
    ])
  })

  it("a judgment authority that is not exactly one reported citation is UNRECOGNISED, masked with the party names", async () => {
    const g = await ground(answer([claim("s", auth("Tariq Zarvani v. The State, 2099")), claim("t", auth("PLD 2099 SC 101, para 12"))]), corpus(), ["Tariq Zarvani"])
    expect(g.citations).toEqual([
      { ref: "UNRECOGNISED: [PARTY] v. The State, 2099", kind: "judgment", source: "claim", status: "UNRECOGNISED", judgmentId: null },
      { ref: "UNRECOGNISED: PLD 2099 SC 101, para 12", kind: "judgment", source: "claim", status: "UNRECOGNISED", judgmentId: null },
    ])
    expect(g.status).toBe("ungrounded")
    expect(JSON.stringify(g)).not.toMatch(/Tariq|Zarvani/)
  })

  it("an extractor suspect in prose is UNRECOGNISED and its ref is bounded", async () => {
    const g = await ground(answer([], "Relied on 2099SCMR456 at length."))
    expect(g.citations).toEqual([{ ref: "UNRECOGNISED: 2099SCMR456", kind: "judgment", source: "text", status: "UNRECOGNISED", judgmentId: null }])
    expect(g.status).toBe("ungrounded")
  })

  it("an unstructured answer: unstructured whatever it cites, its prose citations still resolved and listed", async () => {
    for (const text of [
      "Bail is the rule, as held in PLD 2099 SC 101.",
      "```json\n" + answer([claim("a", auth("PLD 2099 SC 101"))]) + "\n```",
      answer([claim("a", { ...auth("PLD 2099 SC 101"), verified: true } as never)]),
    ]) {
      const g = await ground(text)
      expect(g.status, text.slice(0, 30)).toBe("unstructured")
      expect(g.claims).toEqual({ total: 0, supported: 0 })
      expect(g.citations.map((c) => [c.ref, c.source, c.status])).toEqual([["PLD 2099 SC 101", "text", "VERIFIED"]])
    }
    const urdu = await ground("عدالت نے پی ایل ڈی 2099 سپریم کورٹ 101 میں قرار دیا کہ ضمانت دی جائے۔")
    expect(urdu.status).toBe("unstructured")
    expect(urdu.citations.map((c) => c.status)).toEqual(["UNRECOGNISED"])
  })

  it("an Urdu answer citing a verified judgment in Latin script is grounded", async () => {
    const text = JSON.stringify({
      sections: [{ heading: "ضمانت", text: "سوال یہ ہے کہ کیا ضمانت دی جا سکتی ہے۔", claims: [{ statement: "ضمانت قاعدہ ہے اور انکار استثنا ہے۔", authorities: [{ kind: "judgment", citation: "PLD 2099 SC 101" }] }] }],
      caveats: [],
    })
    expect((await ground(text)).status).toBe("grounded")
  })

  it("no corpus (the EMPTY store, F05): never grounded", async () => {
    const g = await ground(answer([claim("a", auth("PLD 2099 SC 101"))]), EMPTY_AUTHORITY_STORE)
    expect(g.status).toBe("ungrounded")
    expect(g.citations[0]).toMatchObject({ status: "UNVERIFIED", judgmentId: null })
  })

  it("a store that cannot answer: UNAVAILABLE, unverifiable; a definite failure still wins", async () => {
    const g = await ground(answer([claim("a", auth("PLD 2099 SC 101"))]), unavailable)
    expect(g.status).toBe("unverifiable")
    expect(g.citations).toEqual([{ ref: "PLD 2099 SC 101", kind: "judgment", source: "claim", status: "UNAVAILABLE", judgmentId: null }])
    const treatmentsDown: AuthorityStore = { findJudgment: (c) => corpus().findJudgment(c), listTreatments: unavailable.listTreatments, getSectionAsAt: unavailable.getSectionAsAt }
    const t = await ground(answer([claim("a", auth("PLD 2099 SC 101"))]), treatmentsDown)
    expect([t.status, t.citations[0]!.status, t.citations[0]!.judgmentId]).toEqual(["unverifiable", "UNAVAILABLE", "j-good"])
    const mixed = await ground(answer([claim("a", auth("PLD 2099 SC 101"), auth("Section 5, Test Act 2099", "statute"))]), unavailable)
    expect(mixed.status).toBe("ungrounded")
  })

  it("the authority budget: lookups past it are UNAVAILABLE (reason budget), and the answer is unverifiable", async () => {
    let t = 0
    const base = corpus()
    const slow: AuthorityStore = {
      findJudgment: async (c) => ((t += 40), base.findJudgment(c)),
      listTreatments: async (id) => ((t += 40), base.listTreatments(id)),
      getSectionAsAt: async () => "no_history",
    }
    const g = await ground(answer([claim("a", auth("PLD 2099 SC 101")), claim("b", auth("2099 CLC 505"))]), slow, [], { budgetMs: 100, now: () => t })
    expect(g.status).toBe("unverifiable")
    expect(g.citations.map((c) => c.status)).toEqual(["VERIFIED", "UNAVAILABLE"])
  })

  it("any other store error never loses the answer: unverifiable, logged with its code only", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    const broken: AuthorityStore = { ...unavailable, findJudgment: async () => Promise.reject(Object.assign(new Error("Tariq Zarvani secret detail"), { code: "boom" })) }
    const g = await ground(answer([claim("a", auth("PLD 2099 SC 101"))]), broken, ["Tariq Zarvani"])
    expect(g).toEqual({ status: "unverifiable", rules: "f17.2", policy: POLICY, claims: { total: 1, supported: 0 }, citations: [], omitted: 0 })
    expect(warn).toHaveBeenCalledWith("p1.grounding_failed", { code: "boom" })
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Tariq")
  })

  it("at most 100 distinct citations are looked up; the rest are counted in `omitted`, so the answer is at best unverifiable", async () => {
    const lookups: string[] = []
    const everything: AuthorityStore = {
      findJudgment: async (c) => (lookups.push(c), { judgmentId: c, benchType: "division" }),
      listTreatments: async () => [],
      getSectionAsAt: async () => "no_history",
    }
    const prose = Array.from({ length: 101 }, (_, i) => `PLD 2099 SC ${1001 + i}`).join("; ")
    const g = await ground(answer([], prose), everything)
    expect(lookups).toHaveLength(100)
    expect(g.citations).toHaveLength(100)
    expect(g.omitted).toBe(1)
    expect(g.status).toBe("unverifiable")
  })

  it("isAdvisory is false only for grounded", async () => {
    const m = await load()
    for (const status of ["partially_grounded", "ungrounded", "unverifiable", "unstructured", "not_assessed", "anything"]) {
      expect(m.isAdvisory({ status } as Grounding), status).toBe(true)
    }
    expect(m.isAdvisory({ status: "grounded" } as Grounding)).toBe(false)
  })
})
