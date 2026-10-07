import { describe, expect, it } from "vitest"
import { nameForms, usesFallback } from "../src/d1/conflict/normalise"
import { type Candidate, NAME_THRESHOLD, screen, tokenSetRatio } from "../src/d1/conflict/match"

type Subject = Parameters<typeof screen>[0][number]

const CNIC_X = "4210112345671"
const CNIC_Y = "4210176543217"

function cand(over: Partial<Candidate> & { name: string; role: Candidate["role"] }): Candidate {
  return {
    forms: nameForms(over.name),
    keys: {},
    matterId: "m1",
    matterNo: "NHS/2026/0001",
    matterClassification: "confidential",
    matterStatus: "live",
    clientHasLiveMatter: false,
    linkState: "none",
    linkIds: [],
    unresolvedLinkIds: [],
    ...over
  }
}

function run(subjects: Subject[], candidates: Candidate[], opts?: Parameters<typeof screen>[3]) {
  return screen(
    subjects,
    subjects.map((s) => nameForms(s.name)),
    candidates,
    opts
  )
}

describe("tokenSetRatio (rapidfuzz token_set_ratio / 100)", () => {
  it("is 1 when one token set contains the other", () => {
    expect(tokenSetRatio(["muhammad", "ali"], ["muhammad", "ali", "khan"])).toBe(1)
    expect(tokenSetRatio(["ali", "muhammad"], ["muhammad", "ali"])).toBe(1)
  })
  it("scores a one-letter vowel variant at or above the threshold", () => {
    expect(tokenSetRatio(["ali", "raza"], ["ali", "reza"])).toBeGreaterThanOrEqual(0.8)
    expect(tokenSetRatio(["ali", "raza"], ["ali", "reza"])).toBeCloseTo(0.875, 10)
  })
  it("matches rapidfuzz reference values", () => {
    // Values computed with rapidfuzz 3.x fuzz.token_set_ratio, divided by 100.
    expect(tokenSetRatio(["kamran"], ["kamal"])).toBeCloseTo(0.7272727272727272, 10)
    expect(tokenSetRatio(["muhammad", "khan"], ["muhammad", "shahid"])).toBeCloseTo(0.7857142857142857, 10)
    expect(tokenSetRatio(["muhammad", "siddiqui"], ["siddiqui", "mustafa"])).toBeCloseTo(0.7878787878787878, 10)
    expect(tokenSetRatio(["muhammad", "zahid"], ["muhammad", "zahir"])).toBeCloseTo(0.9285714285714286, 10)
    expect(tokenSetRatio(["nadeem"], ["naeem"])).toBeCloseTo(0.9090909090909091, 10)
  })
  it("treats tokens as a set (duplicates and order ignored)", () => {
    expect(tokenSetRatio(["ali", "ali", "khan"], ["khan", "ali"])).toBe(1)
  })
  it("is 0 when either side has no tokens", () => {
    expect(tokenSetRatio([], ["ali"])).toBe(0)
    expect(tokenSetRatio(["ali"], [])).toBe(0)
    expect(tokenSetRatio([], [])).toBe(0)
  })
  it("returns exactly 0.8 for an 8/10 pair (no float drift at the threshold)", () => {
    expect(tokenSetRatio(["zahid"], ["zahir"])).toBe(0.8)
    expect(NAME_THRESHOLD).toBe(0.8)
  })
})

describe("screen: name threshold", () => {
  it("0.79 (26/33, the closest short-name score below 0.80) is not a hit", () => {
    // An exact 0.79 needs a length sum that is a multiple of 100, so the fixture is 26/33 = 0.7879 (2 dp: 0.79).
    const r = run(
      [{ role: "opposing", name: "Muhammad Siddiqui", keys: {} }],
      [cand({ role: "client", name: "Siddiqui Mustafa" })]
    )
    expect(r.hits).toEqual([])
    expect(r.result).toBe("CLEAR")
  })
  it("0.80 exactly is a hit", () => {
    const r = run([{ role: "opposing", name: "Zahid", keys: {} }], [cand({ role: "client", name: "Zahir" })])
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0].basis).toBe("name")
    expect(r.hits[0].score).toBe(0.8)
  })
})

describe("screen: role matrix (P2-4)", () => {
  const cases: Array<[Subject["role"], Candidate["role"], boolean, string]> = [
    ["client", "opposing", false, "adverse_history"],
    ["opposing", "client", true, "direct_adverse"],
    ["opposing", "client", false, "former_client"],
    ["client", "client", true, "informational"]
  ]
  for (const [sr, cr, live, type] of cases) {
    it(`subject ${sr} vs candidate ${cr} (live=${live}) -> ${type}`, () => {
      const r = run(
        [{ role: sr, name: "Muhammad Ali", keys: {} }],
        [cand({ role: cr, name: "Muhammad Ali", clientHasLiveMatter: live })]
      )
      expect(r.hits).toHaveLength(1)
      expect(r.hits[0].type).toBe(type)
      expect(r.hits[0].hitRole).toBe(cr)
    })
  }
  it("opposing vs opposing is informational", () => {
    const r = run(
      [{ role: "opposing", name: "Muhammad Ali", keys: {} }],
      [cand({ role: "opposing", name: "Muhammad Ali" })]
    )
    expect(r.hits[0].type).toBe("informational")
    expect(r.hits[0].outcome).toBe("NONE")
    expect(r.result).toBe("CLEAR")
  })
  it("a same-role hit never raises the result", () => {
    const r = run(
      [{ role: "client", name: "Muhammad Ali", keys: { cnic: CNIC_X } }],
      [cand({ role: "client", name: "Muhammad Ali", keys: { cnic: CNIC_X }, linkState: "confirmed", linkIds: ["l9"] })]
    )
    expect(r.hits[0].type).toBe("informational")
    expect(r.hits[0].outcome).toBe("NONE")
    expect(r.result).toBe("CLEAR")
  })
})

describe("screen: identity basis and outcome (P2-3, P2-5)", () => {
  it("same CNIC + confirmed link, opposing vs live client -> FLAG confirmed_identity", () => {
    const r = run(
      [{ role: "opposing", name: "M. Ali", keys: { cnic: CNIC_X } }],
      [
        cand({
          role: "client",
          name: "Muhammad Ali",
          keys: { cnic: CNIC_X },
          clientHasLiveMatter: true,
          linkState: "confirmed",
          linkIds: ["l1"]
        })
      ]
    )
    expect(r.result).toBe("FLAG")
    expect(r.identityBasis).toBe("confirmed_identity")
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]).toMatchObject({
      subjectIndex: 0,
      hitRole: "client",
      type: "direct_adverse",
      basis: "key",
      score: 1,
      identityBasis: "confirmed_identity",
      outcome: "FLAG",
      matchedName: "Muhammad Ali",
      matterId: "m1",
      matterNo: "NHS/2026/0001",
      matterClassification: "confidential",
      reliedOnLinkIds: ["l1"]
    })
  })
  it("same CNIC + candidate link -> POSSIBLE_CANDIDATE_REVIEW candidate_only", () => {
    const r = run(
      [{ role: "opposing", name: "Muhammad Ali", keys: { cnic: CNIC_X } }],
      [
        cand({
          role: "client",
          name: "Muhammad Ali",
          keys: { cnic: CNIC_X },
          clientHasLiveMatter: true,
          linkState: "candidate",
          linkIds: ["l2"]
        })
      ]
    )
    expect(r.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(r.identityBasis).toBe("candidate_only")
    expect(r.hits[0]).toMatchObject({
      basis: "key",
      identityBasis: "candidate_only",
      outcome: "POSSIBLE_CANDIDATE_REVIEW",
      reliedOnLinkIds: ["l2"]
    })
  })
  it("a key hit with no link at all is candidate_only", () => {
    const r = run(
      [{ role: "client", name: "Zainab Bibi", keys: { phone: "+923001234567" } }],
      [cand({ role: "opposing", name: "Someone Else", keys: { phone: "+923001234567" } })]
    )
    expect(r.hits[0]).toMatchObject({ basis: "key", type: "adverse_history", outcome: "POSSIBLE_CANDIDATE_REVIEW" })
    expect(r.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
  })
  it("NTN and SECP keys hit too", () => {
    const ntn = run(
      [{ role: "client", name: "Alpha Traders", keys: { ntn: "1234567" } }],
      [cand({ role: "opposing", name: "Zeta Corp", keys: { ntn: "1234567" }, linkState: "confirmed" })]
    )
    expect(ntn.result).toBe("FLAG")
    const secp = run(
      [{ role: "client", name: "Alpha Traders", keys: { secp: "0012345" } }],
      [cand({ role: "opposing", name: "Zeta Corp", keys: { secp: "0012345" }, linkState: "confirmed" })]
    )
    expect(secp.result).toBe("FLAG")
  })
  it("name-only hit -> POSSIBLE_CANDIDATE_REVIEW, never FLAG, even with a confirmed link state", () => {
    const r = run(
      [{ role: "opposing", name: "Muhammad Ali", keys: {} }],
      [
        cand({
          role: "client",
          name: "Muhammad Ali",
          clientHasLiveMatter: true,
          linkState: "confirmed",
          linkIds: ["l3"]
        })
      ]
    )
    expect(r.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(r.identityBasis).toBe("candidate_only")
    expect(r.hits[0]).toMatchObject({
      basis: "name",
      score: 1,
      outcome: "POSSIBLE_CANDIDATE_REVIEW",
      identityBasis: "candidate_only",
      reliedOnLinkIds: []
    })
  })
  it("different non-empty CNICs on both sides + identical names -> no hit", () => {
    const r = run(
      [{ role: "opposing", name: "Muhammad Ali", keys: { cnic: CNIC_X, phone: "+923001234567" } }],
      [
        cand({
          role: "client",
          name: "Muhammad Ali",
          keys: { cnic: CNIC_Y, phone: "+923001234567" },
          linkState: "confirmed"
        })
      ]
    )
    expect(r.hits).toEqual([])
    expect(r.result).toBe("CLEAR")
  })
  it("a CNIC on one side only does not veto a name hit", () => {
    const r = run(
      [{ role: "opposing", name: "Muhammad Ali", keys: { cnic: CNIC_X } }],
      [cand({ role: "client", name: "Muhammad Ali" })]
    )
    expect(r.hits).toHaveLength(1)
    expect(r.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
  })
  it("no candidates -> CLEAR with no hits", () => {
    const r = run([{ role: "client", name: "Muhammad Ali", keys: {} }], [])
    expect(r).toEqual({ hits: [], result: "CLEAR", identityBasis: "confirmed_identity" })
  })
  it("subject client whose entity equals the candidate's entity -> FLAG even on a name-only match", () => {
    const r = run(
      [{ role: "client", name: "Muhammad Ali", keys: {}, clientId: "c1" }],
      [cand({ role: "opposing", name: "Muhammad Ali", entityId: "e1" })],
      { subjectEntityIds: ["e1"] }
    )
    expect(r.result).toBe("FLAG")
    expect(r.identityBasis).toBe("confirmed_identity")
    expect(r.hits[0]).toMatchObject({ type: "adverse_history", outcome: "FLAG", identityBasis: "confirmed_identity" })
  })
  it("entity equality without a clientId on the subject does not confirm identity", () => {
    const r = run(
      [{ role: "client", name: "Muhammad Ali", keys: {} }],
      [cand({ role: "opposing", name: "Muhammad Ali", entityId: "e1" })],
      { subjectEntityIds: ["e1"] }
    )
    expect(r.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
  })
  it("a different entity does not confirm identity", () => {
    const r = run(
      [{ role: "client", name: "Muhammad Ali", keys: {}, clientId: "c1" }],
      [cand({ role: "opposing", name: "Muhammad Ali", entityId: "e2" })],
      { subjectEntityIds: ["e1"] }
    )
    expect(r.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
  })
  it("the subject's own entity is a hit even when name and keys changed", () => {
    const r = run(
      [{ role: "client", name: "Renamed Holdings", keys: {}, clientId: "c1" }],
      [cand({ role: "opposing", name: "Old Name Traders", entityId: "e1" })],
      { subjectEntityIds: ["e1"] }
    )
    expect(r.result).toBe("FLAG")
    expect(r.hits[0]).toMatchObject({ basis: "key", score: 1 })
  })
})

describe("screen: forensic test 3 (P2-5)", () => {
  it("client 'Muhammad Ali' CNIC X vs two clients with the same CNIC and an unresolved link -> POSSIBLE_CANDIDATE_REVIEW, never CLEAR", () => {
    const r = run(
      [{ role: "client", name: "Muhammad Ali", keys: { cnic: CNIC_X } }],
      [
        cand({
          role: "client",
          name: "Muhammad Ali",
          keys: { cnic: CNIC_X, phone: "+923001111111" },
          linkState: "candidate",
          linkIds: ["l1"],
          unresolvedLinkIds: ["l1"]
        }),
        cand({
          role: "client",
          name: "Muhammad Ali",
          keys: { cnic: CNIC_X, phone: "+923002222222" },
          linkState: "candidate",
          linkIds: ["l1"],
          unresolvedLinkIds: ["l1"],
          matterId: "m2",
          matterNo: "NHS/2026/0002"
        })
      ]
    )
    expect(r.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(r.result).not.toBe("CLEAR")
    expect(r.identityBasis).toBe("candidate_only")
    expect(r.hits).toHaveLength(2)
    for (const h of r.hits)
      expect(h).toMatchObject({
        type: "informational",
        outcome: "POSSIBLE_CANDIDATE_REVIEW",
        identityBasis: "candidate_only"
      })
  })
  it("an unresolved link makes a review item even when the identity link itself is confirmed", () => {
    const r = run(
      [{ role: "client", name: "Muhammad Ali", keys: { cnic: CNIC_X } }],
      [
        cand({
          role: "client",
          name: "Muhammad Ali",
          keys: { cnic: CNIC_X },
          linkState: "confirmed",
          linkIds: ["l1"],
          unresolvedLinkIds: ["l7"]
        })
      ]
    )
    expect(r.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(r.identityBasis).toBe("candidate_only")
  })
})

describe("screen: hit reporting", () => {
  it("one hit per (subject, candidate) pair, basis key when key and name both match", () => {
    const r = run(
      [{ role: "opposing", name: "Muhammad Ali", keys: { cnic: CNIC_X, phone: "+923001234567" } }],
      [
        cand({
          role: "client",
          name: "Muhammad Ali",
          keys: { cnic: CNIC_X, phone: "+923001234567" },
          linkState: "candidate",
          linkIds: ["l1"]
        })
      ]
    )
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]).toMatchObject({ basis: "key", score: 1 })
  })
  it("reports subjectIndex and takes the max outcome across subjects", () => {
    const r = run(
      [
        { role: "client", name: "Ayesha Siddiqa", keys: {} },
        { role: "opposing", name: "Bilal Ahmed", keys: {} },
        { role: "opposing", name: "Kamran Khan", keys: { cnic: CNIC_X } }
      ],
      [
        cand({ role: "client", name: "Ayesha Siddiqa" }),
        cand({ role: "client", name: "Bilal Ahmed" }),
        cand({
          role: "client",
          name: "Somebody Else",
          keys: { cnic: CNIC_X },
          linkState: "confirmed",
          clientHasLiveMatter: true
        })
      ]
    )
    expect(r.hits.map((h) => [h.subjectIndex, h.outcome])).toEqual([
      [0, "NONE"],
      [1, "POSSIBLE_CANDIDATE_REVIEW"],
      [2, "FLAG"]
    ])
    expect(r.result).toBe("FLAG")
    // a non-NONE hit is candidate_only, so the overall basis is candidate_only
    expect(r.identityBasis).toBe("candidate_only")
  })
  it("ignores NONE hits when computing the overall identity basis", () => {
    const r = run(
      [
        { role: "client", name: "Ayesha Siddiqa", keys: {} },
        { role: "opposing", name: "Kamran Khan", keys: { cnic: CNIC_X } }
      ],
      [
        cand({ role: "client", name: "Ayesha Siddiqa" }),
        cand({ role: "client", name: "Somebody Else", keys: { cnic: CNIC_X }, linkState: "confirmed" })
      ]
    )
    expect(r.result).toBe("FLAG")
    expect(r.identityBasis).toBe("confirmed_identity")
  })
  it("Urdu-script opposing party vs Roman client hits by name (Review Focus 1)", () => {
    const r = run(
      [{ role: "opposing", name: "محمد علی", keys: {} }],
      [cand({ role: "client", name: "Muhammad Ali", clientHasLiveMatter: true })]
    )
    expect(r.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(r.hits[0]).toMatchObject({ basis: "name", type: "direct_adverse" })
  })
  it("compares every subject form with every candidate form", () => {
    const r = screen(
      [{ role: "opposing", name: "x", keys: {} }],
      [[["zzz"], ["muhammad", "ali"]]],
      [cand({ role: "client", name: "Muhammad Ali", forms: [["qqq"], ["muhammad", "ali"]] })]
    )
    expect(r.hits).toHaveLength(1)
  })
})

describe("screen: fallback skeleton comparison (controller ruling)", () => {
  it("بابر via fallback vs client Babar Khan -> POSSIBLE_CANDIDATE_REVIEW with the flag", () => {
    expect(usesFallback("بابر")).toBe(true)
    const subjects: Subject[] = [{ role: "opposing", name: "بابر", keys: {} }]
    const forms = [nameForms("بابر")]
    const c = [cand({ role: "client", name: "Babar Khan" })]
    const withFlag = screen(subjects, forms, c, { subjectFallback: [true] })
    expect(withFlag.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
    expect(withFlag.hits[0]).toMatchObject({ basis: "name", outcome: "POSSIBLE_CANDIDATE_REVIEW" })
    const without = screen(subjects, forms, c)
    expect(without.hits).toEqual([])
    expect(without.result).toBe("CLEAR")
    const flagFalse = screen(subjects, forms, c, { subjectFallback: [false] })
    expect(flagFalse.hits).toEqual([])
  })
  it("a skeleton hit can never FLAG", () => {
    const r = screen(
      [{ role: "opposing", name: "بابر", keys: {} }],
      [nameForms("بابر")],
      [
        cand({ role: "client", name: "Babar Khan", linkState: "confirmed", linkIds: ["l1"], clientHasLiveMatter: true })
      ],
      { subjectFallback: [true] }
    )
    expect(r.result).toBe("POSSIBLE_CANDIDATE_REVIEW")
  })
})
