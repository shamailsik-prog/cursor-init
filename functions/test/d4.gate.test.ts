import { afterEach, describe, expect, it, vi } from "vitest"
import { extractCitations, normaliseCitation } from "@/services/d4-2/citations"
import type { Bench, TreatmentFact } from "@/services/d4-2/citationVerdict"
import {
  EMPTY_AUTHORITY_STORE,
  InMemoryAuthorityStore,
  activeAuthorityStore,
  setAuthorityStoreForTests,
  type AuthorityStore,
} from "../src/d4/authority"
import { runGate } from "../src/d4/gate"
import { GATE_SEVERITY, type TemporalCheck } from "../src/d4/types"

// Fixtures follow P4-13: citations use the year 2099 (read by the extractor, impossible in a real report), statute
// ids look like `test_act_s1`, and no real judgment, statute or party is named.

const TEXT_A = "Test Act s.1 as it stood in 2015: the limit is thirty days."
const TEXT_B = "Test Act s.1 as amended in 2018: the limit is sixty days."

function sectionStore(): InMemoryAuthorityStore {
  const store = new InMemoryAuthorityStore()
  store.addSectionVersion("test_act_s1", "PK", "2010-01-01", "2018-06-01", TEXT_A)
  store.addSectionVersion("test_act_s1", "PK", "2018-06-01", null, TEXT_B)
  return store
}

const check = (usedText: string, asAtDate = "2015-03-01", sectionId = "test_act_s1", jurisdiction = "PK"): TemporalCheck => ({
  sectionId,
  asAtDate,
  jurisdiction,
  usedText,
})

/** Wraps a store and records every call, so a test can prove what was and was not looked up. */
function spyStore(inner: AuthorityStore) {
  const calls = { findJudgment: [] as string[], listTreatments: [] as string[], getSectionAsAt: [] as string[] }
  const store: AuthorityStore = {
    async findJudgment(canonical) {
      calls.findJudgment.push(canonical)
      return inner.findJudgment(canonical)
    },
    async listTreatments(judgmentId) {
      calls.listTreatments.push(judgmentId)
      return inner.listTreatments(judgmentId)
    },
    async getSectionAsAt(sectionId, asAtDate, jurisdiction) {
      calls.getSectionAsAt.push(`${sectionId}|${asAtDate}|${jurisdiction}`)
      return inner.getSectionAsAt(sectionId, asAtDate, jurisdiction)
    },
  }
  return { store, calls }
}

afterEach(() => {
  // Restore NODE_ENV first: the seam refuses to run while it is "production".
  vi.unstubAllEnvs()
  setAuthorityStoreForTests(null)
})

describe("GATE_SEVERITY (P4-6)", () => {
  it("lists the overall statuses most severe first", () => {
    expect([...GATE_SEVERITY]).toEqual(["OVERRULED", "TEMPORAL_MISMATCH", "UNVERIFIED", "TEMPORAL_UNAVAILABLE", "OK"])
  })

  it("is frozen", () => {
    expect(Object.isFrozen(GATE_SEVERITY)).toBe(true)
  })
})

describe("runGate: citations", () => {
  it("G-1 test 4 core: a division-bench judgment overruled by a larger bench is OVERRULED overall", async () => {
    const store = new InMemoryAuthorityStore()
    store.addJudgment("j_101", "PLD 2099 SC 101", "division")
    store.addTreatment("j_larger", "j_101", "overruled", "larger")
    const out = await runGate({ title: "Test petition", body: "As held in PLD 2099 SC 101, the rule applies.", temporalChecks: [] }, store)
    expect(out).toEqual({
      status: "OVERRULED",
      citations: [{ ref: "PLD 2099 SC 101", judgmentId: "j_101", status: "OVERRULED" }],
      temporal: [],
    })
  })

  it("an overruling by a known larger bench is OVERRULED, by an equal known bench UNVERIFIED", async () => {
    const store = new InMemoryAuthorityStore()
    store.addJudgment("j_101", "PLD 2099 SC 101", "division")
    store.addJudgment("j_full", "PLD 2099 SC 300", "full")
    store.addTreatment("j_full", "j_101", "overruled", "full")
    store.addJudgment("j_102", "PLD 2099 SC 102", "division")
    store.addJudgment("j_peer", "PLD 2099 SC 301", "division")
    store.addTreatment("j_peer", "j_102", "overruled", "division")
    const out = await runGate({ title: "T", body: "PLD 2099 SC 101 and PLD 2099 SC 102", temporalChecks: [] }, store)
    expect(out.citations.map((c) => [c.ref, c.status])).toEqual([
      ["PLD 2099 SC 101", "OVERRULED"],
      ["PLD 2099 SC 102", "UNVERIFIED"],
    ])
    expect(out.status).toBe("OVERRULED")
  })

  it("a followed judgment is VERIFIED and the draft is OK", async () => {
    const store = new InMemoryAuthorityStore()
    store.addJudgment("j_101", "PLD 2099 SC 101", "division")
    store.addJudgment("j_full", "PLD 2099 SC 300", "full")
    store.addTreatment("j_full", "j_101", "followed", "full")
    const out = await runGate({ title: "T", body: "See PLD 2099 SC 101.", temporalChecks: [] }, store)
    expect(out).toEqual({
      status: "OK",
      citations: [{ ref: "PLD 2099 SC 101", judgmentId: "j_101", status: "VERIFIED" }],
      temporal: [],
    })
  })

  it("a citation the store does not know is UNVERIFIED with no judgment id", async () => {
    const out = await runGate({ title: "T", body: "See 2099 SCMR 7.", temporalChecks: [] }, new InMemoryAuthorityStore())
    expect(out).toEqual({
      status: "UNVERIFIED",
      citations: [{ ref: "2099 SCMR 7", judgmentId: null, status: "UNVERIFIED" }],
      temporal: [],
    })
  })

  it("reads citations from the title as well as the body", async () => {
    const out = await runGate({ title: "Appeal against PLD 2099 Lahore 55", body: "No authority here.", temporalChecks: [] }, new InMemoryAuthorityStore())
    expect(out.citations.map((c) => c.ref)).toEqual(["PLD 2099 Lahore 55"])
  })

  it("an UNRECOGNISED suspect is UNVERIFIED and is never looked up", async () => {
    const inner = new InMemoryAuthorityStore()
    inner.addJudgment("j_101", "PLD 2099 SC 101", "division")
    const { store, calls } = spyStore(inner)
    const out = await runGate({ title: "T", body: "See 2099SCMR7 and PLD 2099 SC 101.", temporalChecks: [] }, store)
    const suspect = out.citations.find((c) => c.ref.startsWith("UNRECOGNISED: "))
    expect(suspect).toEqual({ ref: "UNRECOGNISED: 2099SCMR7", judgmentId: null, status: "UNVERIFIED" })
    // The only lookup is for the one canonical citation; the suspect never reached the store.
    expect(calls.findJudgment).toEqual(["PLD 2099 SC 101"])
    expect(calls.listTreatments).toEqual(["j_101"])
    expect(out.status).toBe("UNVERIFIED")
  })

  it("an UNRECOGNISED suspect alone makes no store call at all", async () => {
    const { store, calls } = spyStore(new InMemoryAuthorityStore())
    const out = await runGate({ title: "T", body: "C.P. No. 12 of 2099 was cited.", temporalChecks: [] }, store)
    expect(out.status).toBe("UNVERIFIED")
    expect(out.citations).toHaveLength(1)
    expect(calls).toEqual({ findJudgment: [], listTreatments: [], getSectionAsAt: [] })
  })

  it("the same citation written two ways is one finding, matched against a store that spells it a third way", async () => {
    const inner = new InMemoryAuthorityStore()
    inner.addJudgment("j_101", "P.L.D. 2099 S.C. 101", "division")
    const { store, calls } = spyStore(inner)
    const out = await runGate({ title: "pld 2099  sc 101", body: "As in PLD 2099 SC 101 and again P.L.D. 2099 S.C. 101.", temporalChecks: [] }, store)
    expect(out.citations).toEqual([{ ref: "PLD 2099 SC 101", judgmentId: "j_101", status: "VERIFIED" }])
    expect(calls.findJudgment).toEqual(["PLD 2099 SC 101"])
  })

  it("two canonical refs that resolve to one judgment (parallel citations) are one finding, the first ref shown", async () => {
    const parallel: AuthorityStore = {
      async findJudgment(canonical) {
        return canonical === "PLD 2099 SC 101" || canonical === "2099 SCMR 7" ? { judgmentId: "j_same", benchType: "division" } : null
      },
      async listTreatments() {
        return []
      },
      async getSectionAsAt() {
        return "no_history"
      },
    }
    const out = await runGate({ title: "T", body: "2099 SCMR 7 and PLD 2099 SC 101", temporalChecks: [] }, parallel)
    expect(out.citations).toEqual([{ ref: "2099 SCMR 7", judgmentId: "j_same", status: "VERIFIED" }])
  })

  it("two unknown refs stay two findings, in the order the extractor finds them", async () => {
    const body = "PLD 2099 Lahore 55 then 2099 SCMR 7"
    const out = await runGate({ title: "T", body, temporalChecks: [] }, new InMemoryAuthorityStore())
    expect(out.citations).toHaveLength(2)
    expect(out.citations.map((c) => c.ref)).toEqual(extractCitations(`T\n${body}`))
  })

  it("asks the store for the canonical form of a ref, never the draft's own spelling", async () => {
    const { store, calls } = spyStore(new InMemoryAuthorityStore())
    await runGate({ title: "T", body: "P.L.D. 2099 S.C. 101", temporalChecks: [] }, store)
    expect(calls.findJudgment).toEqual([normaliseCitation("P.L.D. 2099 S.C. 101")])
    expect(calls.findJudgment).toEqual(["PLD 2099 SC 101"])
  })
})

describe("runGate: severity order (P4-6)", () => {
  it("OVERRULED outranks UNVERIFIED", async () => {
    const store = new InMemoryAuthorityStore()
    store.addJudgment("j_101", "PLD 2099 SC 101", "division")
    store.addTreatment("j_larger", "j_101", "overruled", "larger")
    const out = await runGate({ title: "T", body: "2099 SCMR 7 then PLD 2099 SC 101", temporalChecks: [] }, store)
    expect(out.citations.map((c) => c.status).sort()).toEqual(["OVERRULED", "UNVERIFIED"])
    expect(out.status).toBe("OVERRULED")
  })

  it("TEMPORAL_MISMATCH outranks UNVERIFIED", async () => {
    const out = await runGate({ title: "T", body: "See 2099 SCMR 7.", temporalChecks: [check(TEXT_B)] }, sectionStore())
    expect(out.citations[0]?.status).toBe("UNVERIFIED")
    expect(out.temporal[0]?.status).toBe("TEMPORAL_MISMATCH")
    expect(out.status).toBe("TEMPORAL_MISMATCH")
  })

  it("OVERRULED outranks TEMPORAL_MISMATCH", async () => {
    const store = sectionStore()
    store.addJudgment("j_101", "PLD 2099 SC 101", "division")
    store.addTreatment("j_larger", "j_101", "overruled", "larger")
    const out = await runGate({ title: "T", body: "PLD 2099 SC 101", temporalChecks: [check(TEXT_B)] }, store)
    expect(out.status).toBe("OVERRULED")
  })

  it("UNVERIFIED outranks TEMPORAL_UNAVAILABLE", async () => {
    const out = await runGate({ title: "T", body: "See 2099 SCMR 7.", temporalChecks: [check(TEXT_A, "2015-03-01", "test_act_s9")] }, sectionStore())
    expect(out.citations[0]?.status).toBe("UNVERIFIED")
    expect(out.temporal[0]?.status).toBe("TEMPORAL_UNAVAILABLE")
    expect(out.status).toBe("UNVERIFIED")
  })

  it("TEMPORAL_UNAVAILABLE alone is the overall status, and is not OK", async () => {
    const out = await runGate({ title: "T", body: "No authority.", temporalChecks: [check(TEXT_A, "2015-03-01", "test_act_s9")] }, sectionStore())
    expect(out.status).toBe("TEMPORAL_UNAVAILABLE")
  })

  it("a VERIFIED citation and an OK temporal check both count as OK", async () => {
    const store = sectionStore()
    store.addJudgment("j_101", "PLD 2099 SC 101", "division")
    const out = await runGate({ title: "T", body: "PLD 2099 SC 101", temporalChecks: [check(TEXT_A)] }, store)
    expect(out.citations[0]?.status).toBe("VERIFIED")
    expect(out.temporal[0]?.status).toBe("OK")
    expect(out.status).toBe("OK")
  })

  it("one bad temporal check among good ones decides the status", async () => {
    const out = await runGate({ title: "T", body: "", temporalChecks: [check(TEXT_A), check(TEXT_B), check(TEXT_A, "2019-01-01")] }, sectionStore())
    expect(out.temporal.map((t) => t.status)).toEqual(["OK", "TEMPORAL_MISMATCH", "TEMPORAL_MISMATCH"])
    expect(out.status).toBe("TEMPORAL_MISMATCH")
  })
})

describe("runGate: temporal checks (P4-6, E-39)", () => {
  it("G-1 test 5 core: a 2015 check using the 2018 text is TEMPORAL_MISMATCH and carries the text in force", async () => {
    const out = await runGate({ title: "T", body: "", temporalChecks: [check(TEXT_B)] }, sectionStore())
    expect(out.status).toBe("TEMPORAL_MISMATCH")
    expect(out.temporal).toEqual([{ ...check(TEXT_B), status: "TEMPORAL_MISMATCH", inForceText: TEXT_A }])
  })

  it("the same check using the 2015 text is OK", async () => {
    const out = await runGate({ title: "T", body: "", temporalChecks: [check(TEXT_A)] }, sectionStore())
    expect(out.status).toBe("OK")
    expect(out.temporal).toEqual([{ ...check(TEXT_A), status: "OK", inForceText: TEXT_A }])
  })

  it("a date inside the later version selects the later text", async () => {
    const out = await runGate({ title: "T", body: "", temporalChecks: [check(TEXT_B, "2020-01-01")] }, sectionStore())
    expect(out.temporal[0]?.status).toBe("OK")
  })

  it("effectiveFrom is inclusive and effectiveTo is exclusive", async () => {
    const out = await runGate(
      {
        title: "T",
        body: "",
        temporalChecks: [
          check(TEXT_A, "2010-01-01"), // first day of version A
          check(TEXT_A, "2018-05-31"), // last day of version A
          check(TEXT_B, "2018-06-01"), // A's effectiveTo is exclusive: B is in force on this day
        ],
      },
      sectionStore()
    )
    expect(out.temporal.map((t) => t.status)).toEqual(["OK", "OK", "OK"])
  })

  it("a date before the first version is TEMPORAL_UNAVAILABLE: nothing was in force", async () => {
    const out = await runGate({ title: "T", body: "", temporalChecks: [check(TEXT_A, "2009-12-31")] }, sectionStore())
    expect(out.temporal).toEqual([{ ...check(TEXT_A, "2009-12-31"), status: "TEMPORAL_UNAVAILABLE", inForceText: null }])
    expect(out.status).toBe("TEMPORAL_UNAVAILABLE")
  })

  it("a date after a closed final version is TEMPORAL_UNAVAILABLE", async () => {
    const store = new InMemoryAuthorityStore()
    store.addSectionVersion("test_act_s2", "PK", "2000-01-01", "2005-01-01", TEXT_A)
    const out = await runGate({ title: "T", body: "", temporalChecks: [check(TEXT_A, "2005-01-01", "test_act_s2")] }, store)
    expect(out.temporal[0]?.status).toBe("TEMPORAL_UNAVAILABLE")
  })

  it("a section with no history is TEMPORAL_UNAVAILABLE, never a silent pass", async () => {
    const out = await runGate({ title: "T", body: "", temporalChecks: [check(TEXT_A, "2015-03-01", "test_act_s9")] }, sectionStore())
    expect(out.temporal).toEqual([{ ...check(TEXT_A, "2015-03-01", "test_act_s9"), status: "TEMPORAL_UNAVAILABLE", inForceText: null }])
    expect(out.status).toBe("TEMPORAL_UNAVAILABLE")
  })

  it("a wrong jurisdiction is TEMPORAL_UNAVAILABLE, not a match on another jurisdiction's text (E-39(1))", async () => {
    const out = await runGate({ title: "T", body: "", temporalChecks: [check(TEXT_A, "2015-03-01", "test_act_s1", "SD")] }, sectionStore())
    expect(out.temporal[0]).toMatchObject({ status: "TEMPORAL_UNAVAILABLE", inForceText: null, jurisdiction: "SD" })
  })

  it("the same section keeps its versions apart per jurisdiction", async () => {
    const store = sectionStore()
    store.addSectionVersion("test_act_s1", "SD", "2010-01-01", null, "Provincial text of the same section.")
    const out = await runGate(
      { title: "T", body: "", temporalChecks: [check(TEXT_A, "2015-03-01", "test_act_s1", "PK"), check("Provincial text of the same section.", "2015-03-01", "test_act_s1", "SD")] },
      store
    )
    expect(out.temporal.map((t) => t.status)).toEqual(["OK", "OK"])
  })

  it("compares after NFC on both sides: a decomposed usedText equals a precomposed in-force text, and the reverse", async () => {
    const precomposed = "café clause"
    const decomposed = "café clause"
    expect(precomposed).not.toBe(decomposed)
    const store = new InMemoryAuthorityStore()
    store.addSectionVersion("test_act_s3", "PK", "2000-01-01", null, precomposed)
    store.addSectionVersion("test_act_s4", "PK", "2000-01-01", null, decomposed)
    const out = await runGate(
      { title: "T", body: "", temporalChecks: [check(decomposed, "2015-03-01", "test_act_s3"), check(precomposed, "2015-03-01", "test_act_s4")] },
      store
    )
    expect(out.temporal.map((t) => t.status)).toEqual(["OK", "OK"])
  })

  it("is otherwise exact: a changed word, case or space is a mismatch", async () => {
    const out = await runGate(
      { title: "T", body: "", temporalChecks: [check(TEXT_A.toLowerCase()), check(`${TEXT_A} `), check(TEXT_A.replace("thirty", "sixty"))] },
      sectionStore()
    )
    expect(out.temporal.map((t) => t.status)).toEqual(["TEMPORAL_MISMATCH", "TEMPORAL_MISMATCH", "TEMPORAL_MISMATCH"])
  })

  it("returns one finding per check, in order, even when two checks are identical", async () => {
    const out = await runGate({ title: "T", body: "", temporalChecks: [check(TEXT_A), check(TEXT_A), check(TEXT_B)] }, sectionStore())
    expect(out.temporal).toHaveLength(3)
    expect(out.temporal.map((t) => t.status)).toEqual(["OK", "OK", "TEMPORAL_MISMATCH"])
  })

  it("sends the store only the section key, the date and the jurisdiction", async () => {
    const { store, calls } = spyStore(sectionStore())
    await runGate({ title: "T", body: "", temporalChecks: [check(TEXT_A)] }, store)
    expect(calls.getSectionAsAt).toEqual(["test_act_s1|2015-03-01|PK"])
  })

  it("does not change the checks it is given", async () => {
    const checks = Object.freeze([Object.freeze(check(TEXT_B))])
    const out = await runGate({ title: "T", body: "", temporalChecks: checks }, sectionStore())
    expect(out.temporal[0]).not.toBe(checks[0])
    expect(checks[0]).toEqual(check(TEXT_B))
  })
})

describe("runGate: nothing to gate", () => {
  it("an empty body and no checks give OK with empty lists", async () => {
    const { store, calls } = spyStore(new InMemoryAuthorityStore())
    const out = await runGate({ title: "", body: "", temporalChecks: [] }, store)
    expect(out).toEqual({ status: "OK", citations: [], temporal: [] })
    expect(calls).toEqual({ findJudgment: [], listTreatments: [], getSectionAsAt: [] })
  })

  it("prose without a citation and no checks give OK", async () => {
    const out = await runGate({ title: "Petition", body: "The petitioner prays for relief.", temporalChecks: [] }, EMPTY_AUTHORITY_STORE)
    expect(out.status).toBe("OK")
  })
})

describe("EMPTY_AUTHORITY_STORE (P4-3: the production adapter until O-59)", () => {
  it("has no judgment, no treatment and no history", async () => {
    expect(await EMPTY_AUTHORITY_STORE.findJudgment("PLD 2099 SC 101")).toBeNull()
    expect(await EMPTY_AUTHORITY_STORE.listTreatments("j_101")).toEqual([])
    expect(await EMPTY_AUTHORITY_STORE.getSectionAsAt("test_act_s1", "2015-03-01", "PK")).toBe("no_history")
  })

  it("turns every citation UNVERIFIED and every check TEMPORAL_UNAVAILABLE", async () => {
    const out = await runGate(
      { title: "T", body: "PLD 2099 SC 101, 2099 SCMR 7 and PLD 2099 Lahore 55.", temporalChecks: [check(TEXT_A), check(TEXT_B, "2020-01-01")] },
      EMPTY_AUTHORITY_STORE
    )
    expect(out.citations.map((c) => c.status)).toEqual(["UNVERIFIED", "UNVERIFIED", "UNVERIFIED"])
    expect(out.citations.every((c) => c.judgmentId === null)).toBe(true)
    expect(out.temporal.map((t) => t.status)).toEqual(["TEMPORAL_UNAVAILABLE", "TEMPORAL_UNAVAILABLE"])
    expect(out.status).toBe("UNVERIFIED")
  })

  it("is frozen", () => {
    expect(Object.isFrozen(EMPTY_AUTHORITY_STORE)).toBe(true)
  })
})

describe("InMemoryAuthorityStore", () => {
  it("findJudgment matches on the normalised stored citation", async () => {
    const store = new InMemoryAuthorityStore()
    store.addJudgment("j_55", "P.L.D. 2099 Lahore 55", "single")
    expect(await store.findJudgment("PLD 2099 Lahore 55")).toEqual({ judgmentId: "j_55", benchType: "single" })
    expect(await store.findJudgment("PLD 2099 Lahore 56")).toBeNull()
  })

  it("a stored citation the extractor cannot read never matches anything", async () => {
    const store = new InMemoryAuthorityStore()
    store.addJudgment("j_bad", "not a citation", "single")
    expect(await store.findJudgment("not a citation")).toBeNull()
  })

  it("listTreatments gives the treating judgment's bench when it is stored, else null, plus the recorded bench", async () => {
    const store = new InMemoryAuthorityStore()
    store.addJudgment("j_101", "PLD 2099 SC 101", "division")
    store.addJudgment("j_full", "PLD 2099 SC 300", "full")
    store.addTreatment("j_full", "j_101", "overruled", "full")
    store.addTreatment("j_unknown", "j_101", "followed", "division")
    store.addTreatment("j_full", "j_other", "overruled", "full")
    const facts: TreatmentFact[] = await store.listTreatments("j_101")
    expect(facts).toEqual([
      { kind: "overruled", treatingJudgmentBench: "full" satisfies Bench, recordedTreatingBench: "full" },
      { kind: "followed", treatingJudgmentBench: null, recordedTreatingBench: "division" },
    ])
    expect(await store.listTreatments("j_none")).toEqual([])
  })

  it("getSectionAsAt returns the text in force or no_history", async () => {
    const store = sectionStore()
    expect(await store.getSectionAsAt("test_act_s1", "2015-03-01", "PK")).toEqual({ text: TEXT_A })
    expect(await store.getSectionAsAt("test_act_s1", "2018-06-01", "PK")).toEqual({ text: TEXT_B })
    expect(await store.getSectionAsAt("test_act_s1", "2009-01-01", "PK")).toBe("no_history")
    expect(await store.getSectionAsAt("test_act_s1", "2015-03-01", "SD")).toBe("no_history")
    expect(await store.getSectionAsAt("test_act_s9", "2015-03-01", "PK")).toBe("no_history")
  })
})

describe("the test seam (P4-3)", () => {
  it("activeAuthorityStore is the empty store until a test sets one", () => {
    expect(activeAuthorityStore()).toBe(EMPTY_AUTHORITY_STORE)
  })

  it("returns the store a test set, and the empty store again after null", () => {
    const store = new InMemoryAuthorityStore()
    setAuthorityStoreForTests(store)
    expect(activeAuthorityStore()).toBe(store)
    setAuthorityStoreForTests(null)
    expect(activeAuthorityStore()).toBe(EMPTY_AUTHORITY_STORE)
  })

  it("throws when NODE_ENV is production, and leaves the active store alone", () => {
    vi.stubEnv("NODE_ENV", "production")
    expect(() => setAuthorityStoreForTests(new InMemoryAuthorityStore())).toThrow("setAuthorityStoreForTests is test-only")
    expect(() => setAuthorityStoreForTests(null)).toThrow("test-only")
    expect(activeAuthorityStore()).toBe(EMPTY_AUTHORITY_STORE)
  })
})
