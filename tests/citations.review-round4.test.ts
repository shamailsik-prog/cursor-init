// Review round 4 (review-secgaps-r4.md): security findings R4-1, R4-3 and the false-positive fixes.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { newStore } from "@/platform/spine/store"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { getDocumentTypes } from "@/lib/foundation-data"
import { extractCitations } from "@/services/d4-2/citations"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"
import { seedJudgment, seedTreatment, verifyCitations } from "@/services/d4-2/draftingIntelligence"


function overruledStore() {
  const store = newStore()
  seedJudgment(store, "j-larger", "Larger", "larger", "2025 SCMR 999")
  seedJudgment(store, "j-over", "Over", "single", "2019 SCMR 1234")
  seedTreatment(store, "j-larger", "j-over", "overruled", "larger")
  for (const d of ["2019 SCMR 1", "2019 SCMR 12", "2019 SCMR 123", "2019 SCMR 34", "2019 SCMR 1204"]) seedJudgment(store, "d-" + d, d, "full", d)
  return store
}

describe("R4-1 (charset): a non-ASCII symbol or punctuation mark between two letters of a Latin token is refused", () => {
  it.each(["∁", "⊂", "¢", "©", "\u{1f172}", "®", "•", "·", "‽", "∴"])("2019 S%sMR 1234", (ch) => {
    const check = checkDraftCharset(`Relying on 2019 S${ch}MR 1234.`)
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.violations.some((v) => /between two letters/.test(v.reason))).toBe(true)
  })
  it("ordinary intra-word punctuation stays allowed (' ’ - – . & /), and symbols outside words too", () => {
    for (const text of [
      "The respondent’s counsel didn't appear",
      "Gulshan-e-Iqbal and Gulshan–e–Iqbal",
      "M/s Engro and AT&T and U.S.A.",
      "Engro® and Sona™ urea; © 2024 Engro",
      "temperature 40°C, § 497 and ¶ 12",
    ]) {
      expect(checkDraftCharset(text).ok, text).toBe(true)
    }
  })
})

describe("R4-1 (gate): a token one edit away from a reporter, next to year/page numbers, is UNVERIFIED", () => {
  it.each([
    "Relying on 2019 SCNR 1234.",
    "Relying on 2019 SXCMR 1234.",
    "Relying on 2019 SMR 1234.",
    "Relying on 2019 S∁MR 1234.",
    "Relying on 2019 S©MR 1234.",
    "Relying on PLQ 2019 SC 123.",
    "Relying on 2019 PCrLX 44.",
  ])("%j", (text) => {
    const refs = extractCitations(text)
    expect(refs.length, text).toBeGreaterThan(0)
    const res = verifyCitations(overruledStore(), refs)
    expect(res.status).not.toBe("OK")
    expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
  })
  it("ordinary words and organisations next to numbers are not suspects", () => {
    for (const text of [
      "the old 2019 rule had 5 parts",
      "In 2023 SECP issued 4 show-cause notices",
      "Since 2020 NADRA has issued 2 CNICs",
      "In 2018 PTI won 116 seats",
      "In 2019 CID filed 5 reports",
    ]) {
      expect(extractCitations(text), text).toEqual([])
    }
  })
})

describe("R4-3: any run of punctuation between page digits makes the page ambiguous", () => {
  it.each(["…", "‥", "‼", "⁇", "⁈", "⁉", "⩴", "︙", "︰", "!!", "?!", "...", ".:", "!)"])("2019 SCMR 12%s34", (junk) => {
    const store = newStore()
    seedJudgment(store, "d12", "Twelve", "full", "2019 SCMR 12")
    const res = verifyCitations(store, extractCitations(`Relying on 2019 SCMR 12${junk}34.`))
    expect(res.status).not.toBe("OK")
    expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
  })
  it("ellipsis or punctuation followed by a space stays prose", () => {
    expect(extractCitations("2019 SCMR 1234... 5 cases")).toEqual(["2019 SCMR 1234"])
    expect(extractCitations("2019 SCMR 1234! 5 cases")).toEqual(["2019 SCMR 1234"])
  })
})


// Review round 4 gate4 probe: every body through the real compose route is 422 — refused by the
// charset layer (unsupported_characters) or blocked by the gate. Never 200.
describe("review round 4 gate4 probe bodies through compose", () => {
  afterEach(() => resetRuntimeStoreForTests())
  let n = 0
  const key = () => `00000000-0000-4000-8444-${String(++n).padStart(12, "0")}`
  function setup() {
    const store = getRuntimeStore()
    const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
    for (const u of ["partner_a", "associate_a", "clerk_a"]) addMember(store, m.id, u, "firmA")
    seedJudgment(store, "j-old", "Old", "single", "2019 SCMR 1234")
    seedJudgment(store, "j-new", "New", "larger", "2021 SCMR 1")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")
    return m.id
  }
  const compose = (matterId: string, body: string) =>
    DRAFTS(new Request("http://127.0.0.1/api/d4/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify({ action: "compose", actorId: "associate_a", matterId, templateId: getDocumentTypes()[0]!.id, title: "x", body, classification: "internal", citedJudgmentIds: [], temporalCitations: [] }),
    }))
  it.each(["Relying on 2019 S\u2201MR 1234.", "Relying on 2019 S\u2282MR 1234.", "Relying on 2019 S\u00a2MR 1234.", "Relying on 2019 S\u00a9MR 1234.", "Relying on 2019 S\ud83c\udd72MR 1234.", "Relying on PL\u2202 2019 SC 123.", "Relying on 2019 SCMR 12\u202634.", "Relying on 2019 SCMR 12\u203c34.", "Relying on 2019 \ufb01 SCMR 1234.", "Relying on 2019 \u212aLR 1234.", "Relying on \u212aLR 2001 SC 1.", "Relying on 2019 \uff33\uff23\uff2d\uff32 1234.", "Relying on 2019 \u015eCMR 1234.", "Relying on 2019 SC\u1e43R 1234.", "Relying on 2019 SC\u00b5R 1234.", "Relying on 2019 \u00c6SCMR 1234.", "Relying on 2019 \ud835\udc12\ud835\udc02\ud835\udc0c\ud835\udc11 1234.", "Relying on 2019 SC\ud835\udcdcR 1234.", "Relying on \u0628\u200d2019 SCMR 1234.", "Relying on 2019 SCMR 12\u03033\u03034.", "Relying on 2019 SCMR 1234\u0303.", "Relying on 2019 SCMR \u0627234.", "Relying on 2019 SCMR 1\u0665\u0665.", "Relying on 2\u0647\u0661\u0669 SCMR 1234.", "Relying on 2019 SCMR \u0661\u0662\u0663\u0664."])("%j is 422", async (body) => {
    expect((await compose(setup(), body)).status).toBe(422)
  })
  it.each(["Relying on 2019 SCMR &#x202E;4321&#x202C;.", "Relying on 2019 SCMR 12&#x200B;34."])("title probe entity body %j is 422", async (body) => {
    expect((await compose(setup(), body)).status).toBe(422)
  })
})

// Found by the round-4 30-seed fuzz sweep: markup residue glued to letters inside a reporter.
describe("fuzz round 4: markup residue glued to letters near numbers is a suspect", () => {
  it.each([
    'Relying on 2019 PCrL<span >class="c">J 4 4 for the proposition.',
    'Relying on 2018 سی ایل <s>pan class="c">سی</span>  789 for the proposition.',
    'Relying on 2019 SCM<span clas>s="c">R\r\n1⸚234.',
    'Relying on 201—8 <span class="c"><CLC</span> 7’89 -> for the proposition.',
    // a page break (FF, now a newline) after an apostrophe inside the page
    "Relying on 2018 \u2004CLC\r\n7'\f89 for the proposition.",
    // a Word line break (VT, now a newline) after ">" inside the page
    "Relying on 2019 SCM\u{1cf20}R 1>\u000b234 for the proposition.",
  ])("%j", (text) => {
    const store = overruledStore()
    seedJudgment(store, "d4", "Four", "full", "2019 PCrLJ 4")
    seedJudgment(store, "d7", "Seven", "full", "2018 CLC 7")
    const check = checkDraftCharset(text)
    expect(check.ok).toBe(true)
    const res = verifyCitations(store, extractCitations(check.ok ? check.normalised : text))
    expect(res.status).not.toBe("OK")
    expect(res.findings.some((f) => f.status === "VERIFIED")).toBe(false)
  })
  it("prose angles, quoted terms and attribute-free text are unaffected", () => {
    expect(extractCitations('where loss < 5% the rule in 2019 SCMR 1234 applies; where > 5% it does not')).toEqual(["2019 SCMR 1234"])
    expect(extractCitations('The term "bayana" was paid in 2019 for 5 plots.')).toEqual([])
  })
})
