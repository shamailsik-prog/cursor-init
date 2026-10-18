import { randomUUID } from "node:crypto"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { POST as committeePost } from "@/app/api/p1/committee-brain/route"
import { resetIdempotencyForTests } from "@/platform/http/idempotency"
import { getProductionFirestore, resetProductionFirestoreForTests } from "@/platform/persistence/adminFirestore"
import { setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import { setTransportForTests } from "@/platform/p1/internalAICaller"
import { resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { testAdminFirestore } from "@/tests/helpers/admin-firestore"
import { seedFirmARuntimeRecords } from "@/tests/helpers/firestore-runtime-seed"

/**
 * Audit F16 review round (Codex P2 on PR #62, spec ruling R4a): the Next `/api/p1/committee-brain` route reads a JSON
 * body of up to 1 MiB and stores the call's `outbound` in one `committee_outputs` document, which Firestore caps at
 * 1 MiB. On the round-1 head c56cf4d the stored outbound held the body twice (`body`, and again in `messages`) plus the
 * system text, so a request of about 850 KB that fit before failed at output persistence, after the provider call.
 * Here the stored outbound holds the body once and names the system policy by id and version, and a request whose
 * stored outbound would exceed 900 KiB is refused in platform/p1 before dispatch, with a reason, and its small row
 * persists.
 *
 * Next Firestore mode on an emulator project of its own (the shared project's firmA rows are paged and counted by
 * tests/persistence.runtime-mode.test.ts), seeded as tests/f10-next-idempotency.e2e.firestore.test.ts seeds it; the
 * provider is faked at the P1 transport boundary only. Run through `npm run test:rules`; skipped without an emulator.
 * Every name is invented.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 })

const PROJECT = "sikander-f16-runtime"
const env = process.env as Record<string, string | undefined>
const savedMode = env.SIKANDER_PERSISTENCE_MODE
const URL = "http://127.0.0.1/api/p1/committee-brain"
const SENTENCE = "Draft the reply. "

type Result = { outputId: string; blocked: boolean; reason?: string; outbound: { body: string } }

/** Everything a Next process holds in memory is gone; Firestore is not. */
function restart() {
  resetRuntimeStoreForTests()
  resetIdempotencyForTests()
  resetProductionFirestoreForTests()
  setFirestorePersistenceForTests(null)
}

/** A matter of firm A with partner_a as a member, as the repositories store it. */
async function seedMatter(): Promise<string> {
  const db = await getProductionFirestore()
  const matterId = `mat_f16_${randomUUID()}`
  await db.collection("matters").doc(matterId).set({
    id: matterId,
    firmId: "firmA",
    clientId: "client_a",
    title: "F16 matter",
    courtId: "SHC",
    caseNumber: null,
    caseNumberStatus: "pending",
    status: "engagement_unconfirmed",
    classification: "internal",
  })
  await db.collection("matter_members").doc(`${matterId}_partner_a`).set({ matterId, userId: "partner_a", firmId: "firmA" })
  return matterId
}

async function ask(matterId: string, body: string): Promise<{ status: number; result?: Result }> {
  const res = await committeePost(
    new Request(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ actorId: "partner_a", matterId, body, purpose: "summarise", classification: "internal" }),
    })
  )
  const json = (await res.json()) as { result?: Result }
  return { status: res.status, result: json.result }
}

const rowOf = async (outputId: string) => (await (await getProductionFirestore()).collection("committee_outputs").doc(outputId).get()).data()

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)("audit F16 review round: the Next committee route stores its outbound once, within a document (Codex P2)", () => {
  let sent = 0

  beforeAll(() => {
    // The default Admin app, on this file's own project; getProductionFirestore() reuses it.
    testAdminFirestore(PROJECT)
  })

  beforeEach(async () => {
    restart()
    env.SIKANDER_PERSISTENCE_MODE = "firestore"
    await seedFirmARuntimeRecords()
    sent = 0
    setTransportForTests({
      async send() {
        sent += 1
        return { text: "Reply." }
      },
    })
  })

  afterEach(() => {
    setTransportForTests(null)
    if (savedMode === undefined) delete env.SIKANDER_PERSISTENCE_MODE
    else env.SIKANDER_PERSISTENCE_MODE = savedMode
    restart()
  })

  it("a body near the bound (867,000 bytes) is sent, and its output row persists holding the body once and no system text", async () => {
    const matterId = await seedMatter()
    const body = SENTENCE.repeat(51_000)
    const { status, result } = await ask(matterId, body)
    expect(status).toBe(200)
    expect(result!.blocked).toBe(false)
    expect(sent).toBe(1)

    const row = await rowOf(result!.outputId)
    expect(row, "the output row persisted").toBeDefined()
    expect(row!.outbound.body).toBe(body)
    expect(JSON.stringify(row).split(SENTENCE).length - 1, "the body is stored once").toBe(51_000)
    expect(row!.outbound).not.toHaveProperty("messages")
    expect(row!.outbound.system).toEqual({ policyId: "summarise", version: expect.any(String) })
  })

  it("a body over the bound (952,000 bytes) is refused before dispatch with a reason, and its small row persists", async () => {
    const matterId = await seedMatter()
    const { status, result } = await ask(matterId, SENTENCE.repeat(56_000))
    expect(status).toBe(200)
    expect(sent).toBe(0)
    expect(result!.blocked).toBe(true)
    expect(result!.reason).toMatch(/too large to store/)

    const row = await rowOf(result!.outputId)
    expect(row, "the refused call's output row persisted").toBeDefined()
    expect(row!.blocked).toBe(true)
    expect(row!.outbound.body).toBe("")
    expect(JSON.stringify(row).length).toBeLessThan(4096)
  })
})
