import { describe, expect, it } from "vitest"
import { InMemoryAuthorityStore } from "../src/d4/authority"
import { groundAnswer, isAdvisory, type Grounding } from "../src/p1/grounding"

/**
 * Audit F17, re-audit round (FAIL 6/10, HIGH-1; spec ruling R7a): an authority named in the prose of an answer that the
 * D4 extractor does not see (a foreign or other law report, a short case or petition number, a case name, a page-only
 * reference) left the answer `grounded` with `advisory: false` when its one claim cited a verified judgment. Every
 * authority-like mention in every prose field (heading, text, statement, pinpoint, caveat) that is not bound to a
 * VERIFIED citation must now be an UNRECOGNISED suspect, which caps the answer at partially_grounded (advisory).
 *
 * This file imports nothing new, so on 63b6fa2 its leak cases fail on their assertions. Fixtures follow P4-13: the year
 * 2099, no real judgment, invented names only.
 */

const POLICY = { policyId: "committee-brain", version: "f17.1" }

function corpus(): InMemoryAuthorityStore {
  const s = new InMemoryAuthorityStore()
  s.addJudgment("j-good", "PLD 2099 SC 101", "division")
  s.addJudgment("j-good-2", "2099 CLC 505", "single")
  return s
}

type Field = "heading" | "text" | "statement" | "pinpoint" | "caveat"

/** A contract answer whose one claim cites the verified PLD 2099 SC 101, with `mention` in one prose field. */
function answerWith(mention: string, field: Field = "text"): string {
  const authority = { kind: "judgment", citation: "PLD 2099 SC 101", ...(field === "pinpoint" ? { pinpoint: mention } : {}) }
  return JSON.stringify({
    sections: [
      {
        heading: field === "heading" ? mention : "Bail on further inquiry",
        text: field === "text" ? `As held in ${mention}, bail is a right.` : "The question is whether bail may be granted where the case calls for further inquiry.",
        claims: [{ statement: field === "statement" ? `Bail is the rule, as in ${mention}.` : "Bail is the rule where the case calls for further inquiry.", authorities: [authority] }],
      },
    ],
    caveats: field === "caveat" ? [mention] : [],
  })
}

/** A contract answer with `text` as its section text and the one verified claim. */
const answerText = (text: string) =>
  JSON.stringify({
    sections: [{ heading: "Bail on further inquiry", text, claims: [{ statement: "Bail is the rule where the case calls for further inquiry.", authorities: [{ kind: "judgment", citation: "PLD 2099 SC 101" }] }] }],
    caveats: [],
  })

const ground = (text: string, partyNames: string[] = []) => groundAnswer({ text, policy: POLICY, partyNames }, corpus())
const suspects = (g: Grounding) => g.citations.filter((c) => c.source !== "claim" && c.status !== "VERIFIED")

/** Not grounded, advisory, the claim still supported, and at least one prose citation that is not VERIFIED. */
function expectFlagged(g: Grounding, label: string): void {
  expect(g.status, `${label}: status`).toBe("partially_grounded")
  expect(isAdvisory(g), `${label}: advisory`).toBe(true)
  expect(g.claims, label).toEqual({ total: 1, supported: 1 })
  expect(suspects(g).length, `${label}: a prose suspect`).toBeGreaterThan(0)
}

function expectGrounded(g: Grounding, label: string): void {
  expect(g.status, `${label}: status (${JSON.stringify(g.citations)})`).toBe("grounded")
  expect(isAdvisory(g), label).toBe(false)
  expect(suspects(g), label).toEqual([])
}

// The re-audit's 18 leaking formats (prose2-head2.txt) and the coordinator's coverage list (ruling R7a).
const REPORTS = [
  "(2099) 3 SCC 777",
  "(2099) 1 SCR 777",
  "AIR 2099 SC 777",
  "[2099] 2 WLR 777",
  "[2099] 1 All ER 777",
  "[2099] AC 77",
  "[2099] QB 77",
  "[2099] 2 KB 77",
  "[2099] Ch 77",
  "[2099] UKSC 77",
  "[2099] UKHL 7",
  "[2099] EWCA Civ 77",
  "[2099] EWHC 777 (Admin)",
  "(2099) 77 DLR (AD) 77",
  "77 DLR (2099) 77",
  "2099 MLD 777",
  "2099 PCr.LJ 77",
  "2099 YLR 77",
  "2099 CLC 77",
  "2099 PLC 77",
  "2099 PTD 77",
  "2099 SCMR 7777",
  "2099 CLD 77",
  "(2099) 4 QXR 77",
  "[2099] 3 ZLR 77",
]
const CASE_NUMBERS = [
  "C.A. 777/2099",
  "C.A. No. 777 of 2099",
  "Civil Appeal 77/2099",
  "Crl.A. 77/2099",
  "Crl. P. 77/2099",
  "C.P. 77/2099",
  "C.P.L.A. 77/2099",
  "W.P. 7777/2099",
  "Writ Petition 77 of 2099",
  "ICA 77/2099",
  "SMC 7/2099",
  "Suo Motu 7/2099",
  "R.F.A. 77/2099",
  "C.R. 77/2099",
  "Const. P. 77/2099",
  "H.C.A. 77/2099",
  "Civil Petition No.7777-L of 2099",
  "Suo Motu Case No. 7 of 2099",
]
const CASE_NAMES = [
  "Haris Qalbani v. Omer Daryani",
  "Qalvo v Nura",
  "Qalvo vs Nura",
  "Qalvo vs. Nura",
  "Qalvo versus Nura",
  "Qalvo v/s Nura",
  "Qalvo V. Nura",
  "Qalvo v. Nura (supra)",
  "Qalvo v. Nura, decided on 1-1-2099",
  "Qalvo v. Nura, 2099",
  "the Qalvo case",
  "Qalvo (supra)",
  "[PARTY] v. The State",
  "حارث قلبانی بنام عمر دریانی",
  "مقدمہ قلوو بنام نورا (2099)",
]
const PAGE_ONLY = [
  "the 2099 judgment of the Supreme Court at page 7777",
  "a judgment reported at page 77 of the 2099 volume",
  "page 7777 of the 2099 judgment",
  "the judgment reported in 2099 at p. 77",
  "سپریم کورٹ کے 2099 کے فیصلے کے صفحہ 7777",
]

describe("audit F17 re-audit HIGH-1: an authority in the prose that is not a verified citation (ruling R7a)", () => {
  it("control: an answer with no authority in its prose stays grounded", async () => {
    expectGrounded(await ground(answerWith("the facts on the record")), "control")
  })

  it("control: a verified citation in the prose stays grounded, in each reporter form the extractor reads", async () => {
    for (const m of ["PLD 2099 SC 101", "PLD 2099 S. C. 101", "2099 CLC 505", "2099 C.L.C. 505"]) expectGrounded(await ground(answerWith(m)), m)
  })

  it.each(REPORTS)("a law report the corpus does not hold, %s, is not grounded", async (m) => {
    expectFlagged(await ground(answerWith(m)), m)
  })

  it.each(CASE_NUMBERS)("a case or petition number, %s, is not grounded", async (m) => {
    expectFlagged(await ground(answerWith(m)), m)
  })

  it.each(CASE_NAMES)("a case name, %s, is not grounded", async (m) => {
    expectFlagged(await ground(answerWith(m)), m)
  })

  it.each(PAGE_ONLY)("a page-only reference, %s, is not grounded", async (m) => {
    expectFlagged(await ground(answerWith(m)), m)
  })

  const FIELDS: Field[] = ["heading", "text", "statement", "pinpoint", "caveat"]
  const ONE_PER_FAMILY = ["(2099) 3 SCC 777", "[2099] 2 WLR 777", "C.A. 777/2099", "Haris Qalbani v. Omer Daryani", "حارث قلبانی بنام عمر دریانی", "the 2099 judgment of the Supreme Court at page 7777"]
  it.each(FIELDS.flatMap((f) => ONE_PER_FAMILY.map((m) => [f, m] as const)))("in the %s field: %s is not grounded", async (field, m) => {
    expectFlagged(await ground(answerWith(m, field)), `${field}: ${m}`)
  })

  it("records each suspect as UNRECOGNISED from the text, by its own words", async () => {
    const g = await ground(answerText("The same view was taken in (2099) 3 SCC 777 and in Haris Qalbani v. Omer Daryani."))
    expect(g.status).toBe("partially_grounded")
    const refs = suspects(g).map((c) => [c.ref, c.status, c.source, c.kind, c.judgmentId])
    expect(refs).toContainEqual(["UNRECOGNISED: (2099) 3 SCC 777", "UNRECOGNISED", "text", "judgment", null])
    expect(refs).toContainEqual(["UNRECOGNISED: Haris Qalbani v. Omer Daryani", "UNRECOGNISED", "text", "judgment", null])
  })

  describe("a case name or number bound to a verified citation is excused; nothing else is", () => {
    it.each([
      ["the citation in a parenthetical after the name", "Qalvo v. Nura (PLD 2099 SC 101) settles it."],
      ["the citation after a comma", "Qalvo v. Nura, PLD 2099 SC 101, settles it."],
      ["the citation right after the name", "Qalvo v. Nura PLD 2099 SC 101 settles it."],
      ["reported as the citation", "Qalvo v. Nura, reported as PLD 2099 SC 101, settles it."],
      ["reported at the citation", "The rule is reported at PLD 2099 SC 101."],
      ["an Urdu name with its citation", "یہ اصول حارث قلبانی بنام عمر دریانی (PLD 2099 SC 101) میں طے ہوا۔"],
      ["a case number with its citation", "C.A. 777/2099 (PLD 2099 SC 101) settles it."],
      ["a page right after the citation", "The judgment in PLD 2099 SC 101 at page 105 settles it."],
      ["a masked party's case with its citation", "[PARTY] v. The State (PLD 2099 SC 101) settles it."],
      ["the same citation twice, each with its own name", "Qalvo v. Nura (PLD 2099 SC 101) and Haris Qalbani v. Omer Daryani (PLD 2099 SC 101) agree."],
    ])("%s: grounded", async (_label, text) => {
      expectGrounded(await ground(answerText(text)), text)
    })

    it("a pinpoint on the verified authority that names only a page of the judgment is excused", async () => {
      expectGrounded(await ground(answerWith("at page 105 of the judgment", "pinpoint")), "pinpoint")
    })

    it.each([
      ["a second name after the bound one (the coordinator's bypass)", "Qalvo v. Nura (PLD 2099 SC 101) and Baz v. Qux", "Baz v. Qux"],
      ["a name before another bound name", "Baz v. Qux and Qalvo v. Nura (PLD 2099 SC 101) agree.", "Baz v. Qux"],
      ["a name after the citation without a parenthesis", "PLD 2099 SC 101 and Baz v. Qux agree.", "Baz v. Qux"],
      // A name binds only before its citation: the D4 extractor reads "(Qalvo v. Nura)" after the page as a sub-series
      // ("PLD 2099 SC(QALVOVNURA) 101", not in the corpus), so this form is never grounded either way.
      ["a name in a parenthetical after the citation", "PLD 2099 SC 101 (Qalvo v. Nura) settles it.", "Qalvo v. Nura"],
      ["a name inside the parenthesis after other words", "PLD 2099 SC 101 (see Baz v. Qux) agrees.", "Baz v. Qux"],
      ["a name before the citation across a semicolon", "Baz v. Qux; PLD 2099 SC 101 agrees.", "Baz v. Qux"],
      ["two names bound to one citation", "Baz v. Qux PLD 2099 SC 101 (Qalvo v. Nura) agree.", "Qalvo v. Nura"],
      ["a name bound to a citation the corpus does not hold", "Baz v. Qux (PLD 2099 SC 7777) agrees.", "Baz v. Qux"],
      ["a page of another judgment after a verified one", "PLD 2099 SC 101 at page 105 and the 2099 judgment at page 7777 agree.", "judgment at page 7777"],
      ["a case number after the citation without a parenthesis", "PLD 2099 SC 101 and C.A. 777/2099 agree.", "C.A. 777/2099"],
      ["reported in a year, apart from the citation", "The rule was reported in 2099, and PLD 2099 SC 101 agrees.", "reported in"],
    ])("%s: not grounded, the unbound one flagged", async (_label, text, flagged) => {
      const g = await ground(answerText(text))
      expect(g.status, text).toBe("partially_grounded")
      expect(isAdvisory(g)).toBe(true)
      expect(suspects(g).some((c) => c.status === "UNRECOGNISED" && c.ref.includes(flagged)), `${text}: ${JSON.stringify(g.citations)}`).toBe(true)
    })

    it("a pinpoint on the verified authority that names a year is not excused", async () => {
      expectFlagged(await ground(answerWith("the 2099 judgment at page 7777", "pinpoint")), "pinpoint with a year")
    })
  })

  it("masks every suspect ref with the call's party names, and keeps at most 80 characters of it", async () => {
    const g = await ground(
      answerText("The rule was laid down in Haris Qalbani v. Omer Daryani and in Qalvo Holdings Limited Karachi Lahore Islamabad v. Tariq Zarvani Peshawar Quetta Multan Sialkot."),
      ["Haris Qalbani", "Omer Daryani", "Tariq Zarvani"]
    )
    expect(g.status).toBe("partially_grounded")
    const refs = suspects(g).map((c) => c.ref)
    expect(refs).toContain("UNRECOGNISED: [PARTY] v. [PARTY]")
    const long = refs.find((r) => r.startsWith("UNRECOGNISED: Qalvo Holdings"))
    expect(long, JSON.stringify(refs)).toContain("v. [PARTY]")
    for (const ref of refs) {
      expect(ref).not.toMatch(/Qalbani|Daryani|Zarvani/u)
      expect([...ref.slice("UNRECOGNISED: ".length)].length).toBeLessThanOrEqual(80)
    }
  })

  it("an unstructured answer records the suspects of its whole text, and stays unstructured", async () => {
    const g = await ground("Bail follows, as held in (2099) 3 SCC 777 and Haris Qalbani v. Omer Daryani.")
    expect(g.status).toBe("unstructured")
    expect(g.citations.map((c) => c.ref)).toEqual(expect.arrayContaining(["UNRECOGNISED: (2099) 3 SCC 777", "UNRECOGNISED: Haris Qalbani v. Omer Daryani"]))
  })

  it("names the rules f17.3", async () => {
    expect((await ground(answerText("t"))).rules).toBe("f17.3")
  })
})
