// Review round 3 design ruling: a draft containing characters that can disguise text is refused
// (422 unsupported_characters, listing code points, positions and categories), not interpreted.
import { createHash } from "node:crypto"
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { POST as FILINGS } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { checkDraftCharset, normaliseDraftBody } from "@/services/d4-2/draftCharset"
import { seedJudgment, seedTreatment } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

const refused = (body: string) => {
  const r = checkDraftCharset(body)
  return r.ok ? [] : r.violations
}

describe("checkDraftCharset", () => {
  it.each([
    ["RLO override", "‮4321 RMCS 9102‬", "U+202E", "Cf"],
    ["RLI isolate", "⁧4321 RMCS 9102⁩", "U+2067", "Cf"],
    ["LRE/PDF", "a‪b‬", "U+202A", "Cf"],
    ["tag character", "2019 SC\u{E0041}MR 1234", "U+E0041", "Cf"],
    ["variation selector VS16", "2019 SCM️R 1234", "U+FE0F", "Mn"],
    ["variation selector VS17", "2019 SCMR 12\u{E0100}34", "U+E0100", "Mn"],
    ["Mongolian FVS", "2019 SCMR 12᠋34", "U+180B", "Mn"],
    ["zero-width space", "2019 SCMR 1​234", "U+200B", "Cf"],
    ["soft hyphen", "2019 SC­MR 1234", "U+00AD", "Cf"],
    ["CGJ", "2019 SC͏MR 1234", "U+034F", "Mn"],
    ["ZWNJ between Latin letters", "a‌b", "U+200C", "Cf"],
    ["bell control", "x\u0007y", "U+0007", "Cc"],
    ["lone CR", "x\ry", "U+000D", "Cc"],
    ["line separator", "2019 SCMR 1234", "U+2028", "Zl"],
    ["paragraph separator", "2019 SCMR 1234", "U+2029", "Zp"],
    ["private use", "2019 SCMR 1234", "U+E000", "Co"],
    ["unassigned", "2019 SCMR \u{50000}", "U+50000", "Cn"],
    ["Greek mu", "2019 s c μ r 1234", "U+03BC", "Ll"],
    ["Greek omicron in year", "2Ο19 SCMR 1234", "U+039F", "Lu"],
    ["Cyrillic Ze as 3", "2019 SCMR 12З4", "U+0417", "Lu"],
    ["Cherokee small letters", "2019 ꮪꮯꮇꭱ 1234", "U+ABAA", "Ll"],
    ["Devanagari digits", "२०१९ SCMR 1234", "U+0968", "Nd"],
    ["Latin small capitals", "2019 ꜱᴄᴍʀ 1234", "U+A731", "Ll"],
    ["small capitals not in UTS #39", "2019 ᴍʀ 1234", "U+1D0D", "Ll"],
    ["Latin dental click", "2019 ǀSCMRǀ 1234", "U+01C0", "Lo"],
    ["Latin retroflex click", "2019 SCMRǃ 1234", "U+01C3", "Lo"],
    ["Common look-alike inside a Latin token", "2019 ∣SCMR∣ 1234", "U+2223", "Sm"],
    ["Latin+Arabic letters in one token", "SCMRا 1234", "U+0627", "Lo"],
  ])("refuses %s", (_label, body, codePoint, category) => {
    const v = refused(body)
    expect(v.length).toBeGreaterThan(0)
    const hit = v.find((x) => x.codePoint === codePoint)
    expect(hit, JSON.stringify(v)).toBeDefined()
    expect(hit?.category).toBe(category)
    expect([...body][hit?.position ?? -1]).toBe(String.fromCodePoint(Number.parseInt(codePoint.slice(2), 16)))
    expect(hit?.reason.length).toBeGreaterThan(0)
  })

  it.each([
    "The petitioner, Mr. Muhammad Ali, relies on 2019 SCMR 1234 — see “para 5” at p. 12; Rs. 5,000/- (50%).",
    "Señor José Müller, Zoë, naïve café, Łódź, Straße, Æsir, Øresund, Dvořák",
    "درخواست گزار کا موقف ۲۰۱۹ می ‌می‌خواهم",
    "بِسْمِ اللَّهِ",
    "Tab\tand\r\nCRLF, €100 © ® ™ § ¶ • …",
    "PLD 2019 SC (AJ&K) 1 and 2019 PLC (C.S.) 77",
  ])("accepts ordinary text %#", (body) => {
    expect(refused(body).filter((v) => v.reason !== "ZWNJ/ZWJ outside Arabic-script letters" || !body.includes("می"))).toEqual([])
  })

  it("ZWNJ between Arabic letters is allowed; elsewhere refused", () => {
    expect(refused("می‌خواهم")).toEqual([])
    expect(refused("می ‌خ")).not.toEqual([])
  })

  it("normalises: CRLF -> LF, NFC, ASCII digits, ASCII dashes", () => {
    expect(normaliseDraftBody("é\r\n۲۰۱۹ SCMR–1234 − １")).toBe("é\n2019 SCMR-1234 - 1")
  })
})

describe("the refusal is enforced before compose, preflight, package creation and approval", () => {
  afterEach(() => resetRuntimeStoreForTests())
  let n = 0
  const key = () => `c3c3c3c3-0000-4000-8000-${String(++n).padStart(12, "0")}`
  const post = (route: typeof DRAFTS, url: string, body: unknown) =>
    route(new Request(`http://127.0.0.1${url}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key() }, body: JSON.stringify(body) }))
  function setup() {
    const store = getRuntimeStore()
    const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
    for (const u of ["partner_a", "associate_a"]) addMember(store, m.id, u, "firmA")
    seedJudgment(store, "j-old", "Old", "single", "2019 SCMR 1234")
    seedJudgment(store, "j-new", "New", "larger", "2021 SCMR 1")
    seedTreatment(store, "j-new", "j-old", "overruled", "larger")
    return { store, matterId: m.id }
  }
  const compose = (matterId: string, body: string, extra: Record<string, unknown> = {}) =>
    post(DRAFTS, "/api/d4/drafts", { action: "compose", actorId: "associate_a", matterId, templateId: getDocumentTypes()[0]!.id, title: "x", body, classification: "internal", ...extra })

  it.each([
    "Relying on 2019 SCMR ‮4321‬.",
    "Relying on ‮4321 RMCS 9102‬.",
    "Relying on 2019 ꜱᴄᴍʀ 1234.",
    "Relying on 2019 ꮪꮯꮇꭱ 1234.",
  ])("compose %j -> 422 unsupported_characters with violations", async (body) => {
    const { store, matterId } = setup()
    const res = await compose(matterId, body)
    expect(res.status).toBe(422)
    const json = (await res.json()) as { code: string; violations: Array<{ codePoint: string; position: number; category: string }> }
    expect(json.code).toBe("unsupported_characters")
    expect(json.violations.length).toBeGreaterThan(0)
    expect([...store.drafts.values()]).toHaveLength(0)
  })

  it("preflight refuses too; even a partner override does not interpret a refused body", async () => {
    const { matterId } = setup()
    const pre = await post(DRAFTS, "/api/d4/drafts", { action: "preflight", actorId: "partner_a", matterId, classification: "internal", body: "x ‮y", partnerOverride: { reason: "r" } })
    expect(pre.status).toBe(422)
    expect(((await pre.json()) as { code: string }).code).toBe("unsupported_characters")
  })

  it("the stored body is the normalised, analysed body; the package sha is computed after normalisation", async () => {
    const { store, matterId } = setup()
    const res = await compose(matterId, "Clean ۱۲ pleading–text.")
    expect(res.status).toBe(200)
    const draftId = ((await res.json()) as { result: { draft: { id: string; body: string } } }).result.draft.id
    expect(store.drafts.get(draftId)?.body).toBe("Clean 12 pleading-text.")
    const pkg = await post(FILINGS, "/api/d4/filings", { action: "create_package", actorId: "associate_a", matterId, draftId, classification: "internal" })
    expect(pkg.status).toBe(200)
    const sha = ((await pkg.json()) as { result: { filingPackage: { draftBodySha256: string } } }).result.filingPackage.draftBodySha256
    expect(sha).toBe(createHash("sha256").update("Clean 12 pleading-text.", "utf8").digest("hex"))
  })

  it("package creation and approval refuse a legacy body with disguising characters", async () => {
    const { store, matterId } = setup()
    const res = await compose(matterId, "Clean pleading.")
    const draftId = ((await res.json()) as { result: { draft: { id: string } } }).result.draft.id
    const draft = store.drafts.get(draftId)!
    store.drafts.set(draftId, { ...draft, body: "Clean ‮pleading." })
    const pkg = await post(FILINGS, "/api/d4/filings", { action: "create_package", actorId: "associate_a", matterId, draftId, classification: "internal" })
    expect(pkg.status).toBe(422)
    expect(((await pkg.json()) as { code: string }).code).toBe("unsupported_characters")
    store.drafts.set(draftId, draft)
    const ok = await post(FILINGS, "/api/d4/filings", { action: "create_package", actorId: "associate_a", matterId, draftId, classification: "internal" })
    const packageId = ((await ok.json()) as { result: { filingPackage: { id: string } } }).result.filingPackage.id
    store.drafts.set(draftId, { ...draft, body: "Clean ‮pleading." })
    const approve = await post(FILINGS, "/api/d4/filings", { action: "decide_package", actorId: "partner_a", packageId, decision: "approve", reason: "ok" })
    expect(approve.status).toBe(422)
    expect(((await approve.json()) as { code: string }).code).toBe("unsupported_characters")
  })
})
