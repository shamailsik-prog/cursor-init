import { FieldValue } from "firebase-admin/firestore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { firmConfigRef, platformConfigRef, reservationRef } from "../src/p1/config"
import * as gateway from "../src/p1/gateway"
import { callP1, p1TestSeam, type P1Request } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { reconcileReservations } from "../src/p1/reconciler"
import { setP1TransportForTests } from "../src/p1/transport"
import { EMULATORS, uniq } from "./emu"

/**
 * Audit F17 review round (Codex P2 on PR #63, `gateway.ts:699`): the reported model must survive a usage commit that
 * fails. The provider attempt on the reservation (step 9b) records the sanitised `modelReported`, and the lease
 * reconciler, which rebuilds the missing `ai_usage_logs` row from that attempt (F08), carries it into the reconciled
 * row. This covers every call, not only an HTTP operation's receipt. A malformed value on an attempt is recorded as
 * null and never stops the settlement; an attempt recorded before F17 (no field) still reconciles, with null.
 */

const T = Date.parse("2026-10-11T10:00:00.000Z")
const at = (ms: number) => ({ now: () => ms })
const afterLease = () => T + (gateway as unknown as { RESERVATION_LEASE_MS: number }).RESERVATION_LEASE_MS + 1_000
const db = () => adminDb()

const req = (firmId: string): P1Request => ({
  firmId,
  actorId: "uid-1",
  matterId: "matter-1",
  jobId: null,
  taskType: "committee",
  classification: "internal",
  body: "Draft a reply to the notice.",
  purpose: "committee-brain",
})

function transport(model: unknown) {
  setP1TransportForTests({
    async send() {
      return { text: "ANSWER", inputTokens: 1000, outputTokens: 500, ...(model === undefined ? {} : { model }) } as never
    },
  })
}

/** A call whose usage commit fails for good: its reservation keeps the hold and the provider attempt (F08). */
async function unsettledCall(model: unknown): Promise<string> {
  const firmId = uniq("firm")
  await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: 1_000_000_000 })
  transport(model)
  p1TestSeam.failCommit = true
  const r = await callP1(req(firmId), at(T))
  p1TestSeam.failCommit = false
  expect([r.outcome, r.accounting]).toEqual(["ok", "pending"])
  expect((await db().collection("ai_usage_logs").doc(r.usageLogId).get()).exists).toBe(false)
  return r.usageLogId
}

const reconcile = () => reconcileReservations({ now: () => afterLease() })
const usageRow = async (id: string) => (await db().collection("ai_usage_logs").doc(id).get()).data()

describe.skipIf(!EMULATORS)("audit F17 review round: the reported model survives reconciliation (Codex P2 on PR #63)", () => {
  beforeEach(() => {
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    setProviderConfigForTests(null)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    delete (p1TestSeam as Record<string, unknown>).failCommit
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    await platformConfigRef().delete()
  })

  it("the provider attempt records the reported model, and the reconciled usage row carries it", async () => {
    const id = await unsettledCall("claude-opus-5.5")
    expect((await reservationRef(id).get()).get("providerAttempt.modelReported")).toBe("claude-opus-5.5")
    expect((await reconcile()).settled).toContain(id)
    expect(await usageRow(id)).toMatchObject({ outcome: "reconciled", reconciledFrom: "recorded", model: "anthropic/claude-opus-5.5", modelReported: "claude-opus-5.5" })
  })

  it("a call whose provider reported no model reconciles with modelReported null", async () => {
    const id = await unsettledCall(undefined)
    expect((await reservationRef(id).get()).get("providerAttempt.modelReported")).toBeUndefined()
    expect((await reconcile()).settled).toContain(id)
    expect((await usageRow(id))?.modelReported).toBeNull()
  })

  it.each([
    ["not a model id", "<b>the best model</b>"],
    ["a number", 42],
    ["an object", { id: "claude-opus-5.5" }],
  ])("a malformed reported model on the attempt (%s) is recorded as null and never stops the settlement", async (_label, bad) => {
    const id = await unsettledCall("claude-opus-5.5")
    await reservationRef(id).update({ "providerAttempt.modelReported": bad })
    expect((await reconcile()).settled).toContain(id)
    expect(await usageRow(id)).toMatchObject({ outcome: "reconciled", reconciledFrom: "recorded", modelReported: null })
  })

  it("an attempt recorded before F17 (no field) still reconciles, with modelReported null", async () => {
    const id = await unsettledCall("claude-opus-5.5")
    await reservationRef(id).update({ "providerAttempt.modelReported": FieldValue.delete() })
    expect((await reconcile()).settled).toContain(id)
    expect(await usageRow(id)).toMatchObject({ outcome: "reconciled", reconciledFrom: "recorded", costMicroUsd: 14_000, modelReported: null })
  })
})
