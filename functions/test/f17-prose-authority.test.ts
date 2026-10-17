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

  it("masks a suspect before bounding it, so a party name across the 80-character cut never leaks", async () => {
    // 68 characters of name before " v. ", so "Tariq Zarvani" starts at 72 and the cut falls inside it.
    const g = await ground(answerText("Held in Qalvoabcdefghij Holdingsabcdefg Limitedabcdefgh Karachiabcdef Lahore v. Tariq Zarvani Peshawar Quetta."), ["Tariq Zarvani"])
    const refs = suspects(g).map((c) => c.ref)
    expect(refs.some((r) => r.includes("[PARTY]")), JSON.stringify(refs)).toBe(true)
    for (const ref of refs) expect(ref).not.toMatch(/Tariq|Zarvani/u)
  })

  it("an unstructured answer records the suspects of its whole text, and stays unstructured", async () => {
    const g = await ground("Bail follows, as held in (2099) 3 SCC 777 and Haris Qalbani v. Omer Daryani.")
    expect(g.status).toBe("unstructured")
    expect(g.citations.map((c) => c.ref)).toEqual(expect.arrayContaining(["UNRECOGNISED: (2099) 3 SCC 777", "UNRECOGNISED: Haris Qalbani v. Omer Daryani"]))
  })

  it("names the rules f17.3", async () => {
    expect((await ground(answerText("t"))).rules).toBe("f17.4")
  })
})

/**
 * Re-audit round 2 (FAIL 7/10 at d729ff8; ruling R7b): the detector was a deny-list over raw text and leaked further
 * forms. Every line the re-auditor marked as a leak in prose3/prose5 (bound forms, controls and the documented limits
 * aside) is a must-catch case below, then the coordinator's list, then the builder's own adversarial matrix of further
 * Pakistani, Indian, UK and US citation habits. Invisible and full-width characters are written as escapes.
 */
describe("audit F17 re-audit round 2: forms that still leaked at d729ff8 (ruling R7b)", () => {
  const AUDITOR_PROSE = [
    "in Qalvo's case the Supreme Court held so",
    "in Nura's case (2099) the Court agreed",
    "In re Qalvo the Court held so",
    "Ex parte Qalvo settles it",
    "In the matter of Qalvo, the Court held so",
    "the case of Qalvo settles it",
    "the Qalvo judgment settles it",
    "the Qalvo matter settles it",
    "Qalvo -v- Nura settles it",
    "Qalvo vrs. Nura settles it",
    "Qalvo, supra, settles it",
    "Qalvo supra settles it",
    "Qalvo (ibid) settles it",
    "قلوو بمقابلہ نورا میں طے ہوا",
    "مقدمہ قلوو میں طے ہوا",
    "قلوو کیس میں طے ہوا",
    "Qalvo banam Nura settles it",
    "(2099) 3 scc 777 settles it",
    "(２０９９) ３ SCC ７７７ settles it",
    "(۲۰۹۹) ۳ SCC ۷۷۷ settles it",
    "(٢٠٩٩) ٣ SCC ٧٧٧ settles it",
    "(2099) 3 S​CC 777 settles it",
    "(2099)​3 SCC 777 settles it",
    "2099 (3) SCALE 777 settles it",
    "JT 2099 (3) SC 777 settles it",
    "550 U.S. 544 (2099) settles it",
    "123 F.3d 456 (9th Cir. 2099) settles it",
    "Case No. 2099/77 settles it",
    "C.A. ۷۷۷/۲۰۹۹ settles it",
    "C.A. 777–2099 settles it",
    "C.A. No. 777 of '99 settles it",
    "R.A. 7/2099 settles it",
    "C.M. 7/2099 settles it",
    "S.A. 7/2099 settles it",
    "W.P.(C) 7/2099 settles it",
    "Cr.P.L.A. 7/2099 settles it",
    "the 2099 decision of the Court at para 77 says so",
    "Benazir's case (supra) settles it",
    "In Zafar Shah's case the Court held so",
    "Al-Jehad Trust case settles it",
    "as held in Qalvo (2099) the Court agreed",
  ]
  it.each(AUDITOR_PROSE)("the re-auditor's leak %j is not grounded", async (text) => {
    expectFlagged(await ground(answerText(text)), text)
  })

  // The coordinator's list (R7b), beyond the re-auditor's lines.
  const COORDINATOR = [
    "Re: Qalvo settles it",
    "Qalvo, ibid, settles it",
    "Qalvo ibid. settles it",
    "Qalvo v/s Nura settles it",
    "قلوو کے مقدمے میں یہی طے ہوا",
    "M/s Qalvo Ltd. v. Nura settles it",
    "Messrs Qalvo v. Nura settles it",
    "Crl.P.L.A. 77/2099 settles it",
    "C.A. 2099/777 settles it",
    "the judgment at paragraph 7 says so",
    "the judgment at ¶ 7 says so",
    "the ruling, para 7, says so",
    "C.A. 777‒2099 settles it",
    "(2099) 3 scc 777 and (2099) 4 Scc 778 agree",
  ]
  it.each(COORDINATOR)("the coordinator's form %j is not grounded", async (text) => {
    expectFlagged(await ground(answerText(text)), text)
  })

  // The builder's own adversarial matrix (R7b item 9): further citation habits, each must flag.
  const SELF_AUDIT = [
    "PLJ 2099 SC 77 settles it",
    "2099 NLR (Criminal) 77 settles it",
    "2099 KLR 77 settles it",
    "2099 MLD 777 [Lahore] settles it",
    "2099 CLC (Kar) 777 settles it",
    "2099 PTD (Trib) 7 settles it",
    "Human Rights Case No. 7 of 2099 settles it",
    "Reference No. 1 of 2099 settles it",
    "Const. P. No. 7 of 2099 settles it",
    "AIR 2099 SC 7 settles it",
    "(2099) 7 SCC (Cri) 7 settles it",
    "2099 SCC OnLine SC 7 settles it",
    "[2099] EWHC 7 (Ch) settles it",
    "Mst. Nura v. Qalvo settles it",
    "Federation of Pakistan v. Qalvo settles it",
    "Qalvo and others v. Nura settles it",
    "The State v. Qalvo settles it",
    "2099 YLR Note 77 settles it",
    "2099 PCr.LJ 77 (Lahore) settles it",
    "Crl. Org. 7/2099 settles it",
    "Civil Petition No. 7-K of 2099 settles it",
    "H.R.C. No. 7 of 2099 settles it",
    "Crl. Rev. 7/2099 settles it",
    "Jail Petition No. 7 of 2099 settles it",
    "C.M.A. 7-K/2099 settles it",
    "2099 Cri LJ 777 settles it",
    "AIR 2099 Bom 77 settles it",
    "ILR 2099 Del 77 settles it",
    "2099 SCC OnLine Del 77 settles it",
    "[2099] 1 AC 77 settles it",
    "[2099] EWCA Crim 7 settles it",
    "(2099) 77 Cr App R 7 settles it",
    "R v Qalvo settles it",
    "77 S. Ct. 777 (2099) settles it",
    "777 F. Supp. 2d 77 (S.D.N.Y. 2099) settles it",
    "Qalvo v. Nura, 550 U.S. 544 (2099), settles it",
    "Id. at 77 says so",
    "مقدمہ بعنوان قلوو بنام نورا میں طے ہوا",
    "قلوو کیس (۲۰۹۹) میں طے ہوا",
    "عدالت عظمیٰ کے فیصلے کے پیرا ۷۷ میں یہی ہے",
  ]
  it.each(SELF_AUDIT)("the builder's adversarial form %j is not grounded", async (text) => {
    expectFlagged(await ground(answerText(text)), text)
  })

  it.each([
    ["the possessive in the statement", "statement" as Field],
    ["the possessive in the heading", "heading" as Field],
    ["the possessive in a pinpoint", "pinpoint" as Field],
    ["the possessive in a caveat", "caveat" as Field],
  ])("%s is not grounded", async (_label, field) => {
    expectFlagged(await ground(answerWith("Qalvo's case", field)), field)
  })

  // Statutes with a year, the matter's own record numbers and ordinary legal prose stay grounded (R7b item 4): flagging
  // them would make sound answers advisory wholesale. A statute in the prose is not an authority the corpus resolves
  // (residual risk 9).
  it.each([
    "The Contract Act, 1872 governs the agreement.",
    "Section 497 of the Code of Criminal Procedure, 1898 applies.",
    "Section 302 PPC, 1860 read with section 34 PPC applies.",
    "The Ordinance, 2099 and the Rules of 2099 apply.",
    "Order XXXIX Rule 1 of the Code of Civil Procedure, 1908 applies.",
    "Under the Constitution of 2099, Article 10-A applies.",
    "Act No. 7 of 2099 and Notification No. 7 of 2099 apply.",
    "The FIR No. 77/2099 was registered at the police station.",
    "This case turns on its facts, and the prosecution case is weak.",
    "The Supreme Court has held so in a number of cases.",
    "مقدمہ درج ہوا اور ضمانت کی درخواست دائر کی گئی۔",
    "اس کیس میں ضمانت دی جا سکتی ہے۔",
  ])("stays grounded: %j", async (text) => {
    expectGrounded(await ground(answerText(text)), text)
  })

  it("documented limit: a bare name with no case marker cannot be detected (residual risk)", async () => {
    // "grounded" means every claim's authorities are VERIFIED and the prose holds no unverified authority in a
    // recognised form; "as observed in Qalvo" names an authority in no recognised form.
    expectGrounded(await ground(answerText("As observed in Qalvo, bail follows.")), "bare name")
  })

  it("normalises before reading: a name split by a zero-width character is masked whole", async () => {
    const g = await ground(answerText("The rule in Tariq Zar​vani v. The State applies."), ["Tariq Zarvani"])
    expect(g.status).toBe("partially_grounded")
    expect(suspects(g).map((c) => c.ref)).toContain("UNRECOGNISED: [PARTY] v. The State")
    expect(JSON.stringify(g.citations)).not.toMatch(/Tariq|Zarvani|Zar|vani/u)
  })

  // Re-audit LOW P15: a mask placeholder counts as a name.
  it("a placeholder inside a name lets the name bind to its verified citation", async () => {
    expectGrounded(await ground(answerText("Qalvo v. [PARTY] Holdings (PLD 2099 SC 101) settles it.")), "placeholder in a bound name")
  })
  it("the [PARTY] case is not grounded", async () => {
    expectFlagged(await ground(answerText("The [PARTY] case settles it.")), "the [PARTY] case")
  })

  // Re-audit LOW name cut: no partial party name in any ref, on unmasked input, however long the name.
  it("a seven-word party name never appears in part in a ref", async () => {
    const name = "Haris Qalbani Omer Daryani Nura Baz Quxo"
    const g = await ground(
      answerText(`${name} v. The State settles it, and so does the judgment in ${"y".repeat(60)} ${name} matter at page 7.`),
      [name]
    )
    expect(g.status).toBe("partially_grounded")
    const blob = JSON.stringify(g.citations)
    for (const word of name.split(" ")) expect(blob, word).not.toContain(word)
  })

  it("cuts a long suspect at a word boundary", async () => {
    // 81 characters: the 80-character cut falls inside the last word.
    const name = "Qalvoabcdefghij Holdingsabcdefg Limitedabcdefgh Karachiabcdef v. Nuraabcdefghijkl"
    const g = await ground(answerText(`The rule in ${name} applies.`))
    const ref = suspects(g).map((c) => c.ref).find((r) => r.includes("Qalvoabcdefghij"))!
    const words = name.split(" ")
    for (const w of ref.slice("UNRECOGNISED: ".length).split(" ")) expect(words, `${ref}: ${w}`).toContain(w)
  })
})

// Re-audit LOW P02 and P03: the 100-citation cap fails safe.
describe("audit F17 re-audit round 2: the citation cap fails safe (LOW P02, P03)", () => {
  const many = (): InMemoryAuthorityStore => {
    const s = new InMemoryAuthorityStore()
    for (let i = 1; i <= 100; i += 1) s.addJudgment(`j-${i}`, `PLD 2099 SC ${i}`, "division")
    return s
  }

  it("100 verified authorities in the claims and a prose suspect past the cap: never grounded", async () => {
    const claims = Array.from({ length: 10 }, (_, c) => ({
      statement: `Claim ${c}.`,
      authorities: Array.from({ length: 10 }, (_, a) => ({ kind: "judgment", citation: `PLD 2099 SC ${c * 10 + a + 1}` })),
    }))
    const text = JSON.stringify({ sections: [{ heading: "H", text: "The same view was taken in (2099) 3 SCC 777.", claims }], caveats: [] })
    const g = await groundAnswer({ text, policy: POLICY, partyNames: [] }, many())
    expect(g.claims).toEqual({ total: 10, supported: 10 })
    expect(g.status).not.toBe("grounded")
    expect(isAdvisory(g)).toBe(true)
    expect(g.omitted).toBeGreaterThanOrEqual(1)
  })

  it("prose suspects count toward the cap: 150 of them record at most 100 citations, the rest omitted", async () => {
    const prose = Array.from({ length: 150 }, (_, i) => `(2099) 3 SCC ${i + 1}`).join(", ")
    const g = await ground(answerText(`The same view was taken in ${prose}.`))
    expect(g.citations.length).toBeLessThanOrEqual(100)
    expect(g.omitted).toBeGreaterThanOrEqual(50)
    expect(g.status).not.toBe("grounded")
  })
})
