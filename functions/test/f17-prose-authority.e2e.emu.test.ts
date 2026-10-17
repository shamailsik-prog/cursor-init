import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { InMemoryAuthorityStore, setAuthorityStoreForTests } from "../src/d4/authority"
import { firmConfigRef, platformConfigRef } from "../src/p1/config"
import { setOpikFetchForTests } from "../src/p1/opik"
import { setP1TransportForTests } from "../src/p1/transport"
import { viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Audit F17, re-audit round (FAIL 6/10, HIGH-1; spec ruling R7a), end to end through the real `committeeBrain` route
 * (`viaApi`: ROUTES, the ID token, the session binding) over the Auth and Firestore emulators, the provider faked at the
 * transport boundary and the corpus the F05 store seam. On 63b6fa2 an answer whose one claim cites the verified
 * PLD 2099 SC 101 and whose prose names an authority the D4 extractor does not see (a foreign report, a short case
 * number, a case name, a page-only reference) is returned and stored as `grounded` with `advisory: false`. Started from
 * the re-auditor's scratch repro (zz-audit-f17-route.e2e.emu.test.ts). This file imports nothing new in the fix.
 * Every name is invented; every citation is synthetic (2099).
 */

const T = Date.parse("2026-10-11T10:00:00.000Z") + 80 * 3_600_000

type Citation = { ref: string; kind: string; source: string; status: string; judgmentId: string | null }
type Out = { outputId: string; blocked: boolean; grounding?: { status: string; claims: { total: number; supported: number }; citations: Citation[] }; advisory?: boolean }
type Firm = { firmId: string; matterId: string; token: string }

function spread() {
  let ms = T
  return { now: () => (ms += 61_000) }
}
const brain = viaApi<Out>("committeeBrain", spread())

function capture(text: string): void {
  setP1TransportForTests({
    async send() {
      return { text, inputTokens: 1000, outputTokens: 500, model: "anthropic/claude-opus-5.5" } as never
    },
  })
}

async function newFirm(parties: string[] = []): Promise<Firm> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: 1_000_000_000 })
  const matterId = uniq("matter")
  await adminDb().collection("matters").doc(matterId).set({ firmId, classification: "internal", title: "Bail application", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
  for (const name of parties) await adminDb().collection("matter_parties").doc().set({ firmId, matterId, role: "client", classification: "internal", matterStatus: "live", name })
  const P = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  await adminDb().collection("matter_members").doc(`${matterId}_${P.uid}`).set({ firmId, matterId, userId: P.uid, classification: "internal" })
  return { firmId, matterId, token: P.token }
}

const BODY = "Can the accused be granted bail where the case calls for further inquiry?"
const ask = (f: Firm) => brain({ token: f.token, data: { firmId: f.firmId, matterId: f.matterId, body: BODY } } as never)
const outputOf = async (outputId: string): Promise<DocumentData> => (await adminDb().collection("committee_outputs").doc(outputId).get()).data()!

function corpus(): InMemoryAuthorityStore {
  const s = new InMemoryAuthorityStore()
  s.addJudgment("j-good", "PLD 2099 SC 101", "division")
  return s
}

/** A contract answer whose one claim cites the verified PLD 2099 SC 101 and whose section text is `text`. */
const answer = (text: string) =>
  JSON.stringify({
    sections: [{ heading: "Bail on further inquiry", text, claims: [{ statement: "Bail is the rule where the case calls for further inquiry.", authorities: [{ kind: "judgment", citation: "PLD 2099 SC 101" }] }] }],
    caveats: [],
  })

describe.skipIf(!EMULATORS)("audit F17 re-audit HIGH-1: a prose authority through the committeeBrain route (ruling R7a)", () => {
  beforeEach(() => {
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    vi.stubEnv("SIKANDER_CORPUS_READER_URL", undefined)
    setProviderConfigForTests(null)
    setAuthorityStoreForTests(corpus())
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    setAuthorityStoreForTests(null)
    await platformConfigRef().delete()
  })

  it.each([
    ["a foreign SCC report", "The Supreme Court of India took the same view in (2099) 3 SCC 777, which settles the point.", "(2099) 3 SCC 777"],
    ["an English WLR report", "The House of Lords agreed in [2099] 2 WLR 777.", "[2099] 2 WLR 777"],
    ["a short case number", "This Court followed the same rule in C.A. 777/2099.", "C.A. 777/2099"],
    ["an English case name", "The principle was first laid down in Haris Qalbani v. Omer Daryani and has been followed since.", "Haris Qalbani v. Omer Daryani"],
    ["an Urdu case name", "یہ اصول حارث قلبانی بنام عمر دریانی میں طے ہوا۔", "بنام"],
    ["a page-only reference", "The 2099 judgment of the Supreme Court at page 7777 is to the same effect.", "page 7777"],
    ["a second case name after one bound to the citation (bypass)", "Qalvo v. Nura (PLD 2099 SC 101) and Baz v. Qux agree.", "Baz v. Qux"],
  ])("%s in the prose: partially_grounded and advisory, returned and stored", async (_label, text, flagged) => {
    const f = await newFirm()
    capture(answer(text))
    const r = await ask(f)
    expect(r.blocked).toBe(false)
    expect(r.grounding?.status, "grounding status").toBe("partially_grounded")
    expect(r.advisory).toBe(true)
    expect(r.grounding?.claims).toEqual({ total: 1, supported: 1 })
    expect(
      r.grounding?.citations.some((c) => c.source === "text" && c.status === "UNRECOGNISED" && c.ref.startsWith("UNRECOGNISED: ") && c.ref.includes(flagged)),
      JSON.stringify(r.grounding?.citations)
    ).toBe(true)
    const row = await outputOf(r.outputId)
    expect([row.grounding.status, row.advisory]).toEqual(["partially_grounded", true])
    expect(row.grounding.citations).toEqual(r.grounding?.citations)
  })

  it("a case name bound to the verified citation in its parenthetical: grounded, not advisory, stored the same", async () => {
    const f = await newFirm()
    capture(answer("Qalvo v. Nura (PLD 2099 SC 101) settles the point."))
    const r = await ask(f)
    expect(r.grounding?.status, JSON.stringify(r.grounding?.citations)).toBe("grounded")
    expect(r.advisory).toBe(false)
    expect(r.grounding?.citations).toEqual([{ ref: "PLD 2099 SC 101", kind: "judgment", source: "both", status: "VERIFIED", judgmentId: "j-good" }])
    const row = await outputOf(r.outputId)
    expect([row.grounding.status, row.advisory]).toEqual(["grounded", false])
  })

  it("a matter party's name in a suspect is masked in the answer and the stored record", async () => {
    const f = await newFirm(["Haris Qalbani"])
    capture(answer("The principle was first laid down in Haris Qalbani v. Omer Daryani."))
    const r = await ask(f)
    expect(r.grounding?.status).toBe("partially_grounded")
    expect(r.grounding?.citations.map((c) => c.ref)).toContain("UNRECOGNISED: [PARTY] v. Omer Daryani")
    const row = await outputOf(r.outputId)
    expect(JSON.stringify(row.grounding)).not.toContain("Qalbani")
  })
})
