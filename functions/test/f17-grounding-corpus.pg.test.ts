import path from "node:path"
import { Timestamp } from "firebase-admin/firestore"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { setAuthorityStoreForTests } from "../src/d4/authority"
import { firmConfigRef, platformConfigRef } from "../src/p1/config"
import { setOpikFetchForTests } from "../src/p1/opik"
import { setP1TransportForTests } from "../src/p1/transport"
import { viaApi } from "./api"
import { CORPUS_FIXTURES, type CorpusDb, type PublishSummary, createCorpusDb, resetAuthorityStore, withCorpusReaderEnv } from "./corpusPg"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Audit F17 (spec ruling 7(c), recorded decision): committee-output grounding against the firm's real promoted Annex A
 * corpus. End to end through the HTTP router (`committeeBrain`, real ID tokens, the Auth and Firestore emulators) with
 * the authority answered by the F05 corpus reader (PgAuthorityStore) on real Postgres, seeded the way an operator seeds
 * it: the publication CLI with the F05 curated batch. The provider is faked at the transport boundary only.
 *
 * Runs in the F05 suite only (`npm run test:f05-authority`, CI job "Authority corpus e2e (F05)"), where a missing
 * SIKANDER_POSTGRES_URL fails the run instead of skipping it (test/corpusPg.ts). This file imports nothing new in F17,
 * so on main it loads and its assertions are what fail. Fixtures follow P4-13: the year 2099, no real judgment.
 */

if (!EMULATORS) {
  throw new Error("the F17 corpus e2e needs the Auth and Firestore emulators: run it with `npm run test:f05-authority`")
}

type Citation = { ref: string; kind: string; source: string; status: string; judgmentId: string | null }
type Out = { outputId: string; blocked: boolean; text?: string; grounding?: { status: string; claims: unknown; citations: Citation[] }; advisory?: boolean }

const T = Date.parse("2026-10-11T10:00:00.000Z")
const MAIN_BATCH = path.join(CORPUS_FIXTURES, "curated-batch.f05.json")
const SLOW = 60_000

let db: CorpusDb
let restoreEnv: () => void = () => undefined
let published: PublishSummary
const J: Record<string, string> = {}
const createdFirms: string[] = []

function spread() {
  let ms = T
  return { now: () => (ms += 61_000) }
}
const brain = viaApi<Out>("committeeBrain", spread())

function capture(text: string): void {
  setP1TransportForTests({
    async send() {
      return { text, inputTokens: 1000, outputTokens: 500 }
    },
  })
}

async function ask(text: string): Promise<Out> {
  const firmId = uniq("firm")
  createdFirms.push(firmId)
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: 1_000_000_000 })
  const matterId = uniq("matter")
  await adminDb().collection("matters").doc(matterId).set({ firmId, classification: "internal", title: "Bail application", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
  const P = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
  await adminDb().collection("matter_members").doc(`${matterId}_${P.uid}`).set({ firmId, matterId, userId: P.uid, classification: "internal" })
  capture(text)
  return brain({ token: P.token, data: { firmId, matterId, body: "Is bail available where the case calls for further inquiry?" } } as never)
}

const answerCiting = (...citations: string[]) =>
  JSON.stringify({
    sections: [
      {
        heading: "Bail on further inquiry",
        text: "The prosecution case calls for further inquiry.",
        claims: citations.map((citation, i) => ({ statement: `Proposition ${i + 1} of the answer.`, authorities: [{ kind: "judgment", citation }] })),
      },
    ],
    caveats: [],
  })

beforeAll(async () => {
  db = await createCorpusDb("f17")
  published = await db.publish(MAIN_BATCH)
  for (const o of published.items) if (o.entity_type === "judgment" && o.entity_id) J[o.item_key] = o.entity_id
  restoreEnv = withCorpusReaderEnv(db)
}, 240_000)

afterAll(async () => {
  restoreEnv()
  await resetAuthorityStore()
  await Promise.all(createdFirms.map((id) => adminDb().collection("firms").doc(id).delete()))
  await db?.drop()
}, 120_000)

beforeEach(async () => {
  vi.stubEnv("OPIK_BASE_URL", undefined)
  vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
  setProviderConfigForTests(null)
  // The production selection path: no test store, so grounding runs on what the environment configures.
  setAuthorityStoreForTests(null)
  await resetAuthorityStore()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  setP1TransportForTests(null)
  setOpikFetchForTests(null)
  await platformConfigRef().delete()
})

describe("audit F17: committee answers grounded against the promoted Annex A corpus (real Postgres)", () => {
  it("the fixture publishes the judgments this file relies on (precondition)", () => {
    for (const key of ["j-verified", "j-overruled", "j-larger", "j-pending"]) expect(J[key], key).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("a claim citing a promoted judgment that is good law is grounded and not advisory", async () => {
    const r = await ask(answerCiting("2099 SCMR 101"))
    expect(r.blocked).toBe(false)
    expect(r.grounding?.status, "grounding status").toBe("grounded")
    expect(r.advisory).toBe(false)
    expect(r.grounding?.citations).toEqual([{ ref: "2099 SCMR 101", kind: "judgment", source: "claim", status: "VERIFIED", judgmentId: J["j-verified"] }])
    expect((await adminDb().collection("committee_outputs").doc(r.outputId).get()).get("grounding.status")).toBe("grounded")
  }, SLOW)

  it("a claim citing a judgment overruled by a larger bench is ungrounded: OVERRULED", async () => {
    const r = await ask(answerCiting("2099 SCMR 202"))
    expect(r.grounding?.status, "grounding status").toBe("ungrounded")
    expect(r.advisory).toBe(true)
    expect(r.grounding?.citations).toEqual([{ ref: "2099 SCMR 202", kind: "judgment", source: "claim", status: "OVERRULED", judgmentId: J["j-overruled"] }])
  }, SLOW)

  it("a judgment under an overruling held for review is PENDING_OVERRULING; a fabricated one UNVERIFIED; one good claim makes it partially grounded", async () => {
    const r = await ask(answerCiting("2099 SCMR 101", "2099 SCMR 505", "2099 SCMR 999"))
    expect(r.grounding?.status, "grounding status").toBe("partially_grounded")
    expect(r.advisory).toBe(true)
    expect(r.grounding?.citations).toEqual([
      { ref: "2099 SCMR 101", kind: "judgment", source: "claim", status: "VERIFIED", judgmentId: J["j-verified"] },
      { ref: "2099 SCMR 505", kind: "judgment", source: "claim", status: "PENDING_OVERRULING", judgmentId: J["j-pending"] },
      { ref: "2099 SCMR 999", kind: "judgment", source: "claim", status: "UNVERIFIED", judgmentId: null },
    ])
  }, SLOW)
})
