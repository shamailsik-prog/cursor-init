import { beforeEach, describe, expect, it } from "vitest"
import { Timestamp } from "firebase-admin/firestore"
import { HttpsError } from "firebase-functions/v2/https"
import { adminAuth, adminDb } from "../src/admin"
import { createRouter, ROUTES } from "../src/http/router"
import { onboardFirmHandler } from "../src/p5/identity"
import { recordGatePassHandler } from "../src/p5/gates"
import { EMULATORS, callableAuth, mintIdToken } from "./emu"

/**
 * R-5 (L18 R-5, v19 line 6724): no second firm is onboarded until tenant
 * isolation has passed a live cross-tenant test (Gate G-2). The pass is
 * recorded only by a platform admin through recordGatePass, with evidence,
 * audited; onboardFirm's platformAdmin path refuses a second firm until then.
 */

async function httpsErrorOf(p: Promise<unknown>): Promise<HttpsError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(HttpsError)
    return e as HttpsError
  }
  throw new Error("expected HttpsError, promise resolved")
}

function expectHttps(err: HttpsError, code: string, detail: string) {
  expect({ code: err.code, details: err.details }).toEqual({ code, details: { code: detail } })
}

async function req(token: string, data: Record<string, unknown>) {
  return { auth: await callableAuth(token), data } as never
}

async function auditRows(actorId: string, action: string) {
  const snap = await adminDb().collection("audit_log").where("actorId", "==", actorId).where("action", "==", action).get()
  return snap.docs.map((d) => d.data())
}

const bootstrapRef = () => adminDb().collection("platform").doc("bootstrap")
const gatesRef = () => adminDb().collection("platform").doc("gates")
const EVIDENCE = { summary: "gate:g2 green: 0 allows over every implemented read path", commitSha: "6e66bf1" }

/** A platform with its first firm already onboarded (so the next onboardFirm is a second firm). */
async function firstFirmExists(): Promise<void> {
  const founder = await mintIdToken(null)
  await onboardFirmHandler(await req(founder.token, { name: "First" }))
}

describe.skipIf(!EMULATORS)("recordGatePass (platform admin records a gate pass with evidence)", () => {
  const ACTION = "platform.recordGatePass"

  beforeEach(async () => {
    await gatesRef().delete()
  })

  it("platform admin → platform/gates.g2PassedAt set, evidence and passer stored, gate_passes row, one allow audit row", async () => {
    const admin = await mintIdToken({ platformAdmin: true })
    const res = (await recordGatePassHandler(await req(admin.token, { gate: "G-2", evidence: EVIDENCE }))) as {
      gate: string
      passId: string
    }
    expect(res.gate).toBe("G-2")

    const gates = (await gatesRef().get()).data()
    expect(gates?.g2PassedAt).toBeInstanceOf(Timestamp)
    expect(gates).toMatchObject({ g2PassedBy: admin.uid, g2Evidence: EVIDENCE, g2PassId: res.passId })

    const pass = (await adminDb().collection("gate_passes").doc(res.passId).get()).data()
    expect(pass).toMatchObject({ gate: "G-2", evidence: EVIDENCE, recordedBy: admin.uid })
    expect(pass?.at).toBeInstanceOf(Timestamp)

    const rows = await auditRows(admin.uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "allow", reason: "ok", target: `gate_passes/${res.passId}` })
  })

  it.each([
    ["no claims", null],
    ["platformAdmin: 'true' (string)", { platformAdmin: "true" }],
    ["a firm partner", { firmId: "firm-x", role: "partner", clearanceLevel: "privileged-restricted" }],
  ])("%s → permission-denied platform_admin_only; nothing stored; one deny row", async (_label, claims) => {
    const caller = await mintIdToken(claims as Record<string, unknown> | null, { userDoc: false })
    const err = await httpsErrorOf(recordGatePassHandler(await req(caller.token, { gate: "G-2", evidence: EVIDENCE })))
    expectHttps(err, "permission-denied", "platform_admin_only")
    expect((await gatesRef().get()).exists).toBe(false)
    const rows = await auditRows(caller.uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "deny", reason: "platform_admin_only" })
  })

  it.each([["G-3"], ["g-2"], [""], [2], [undefined]])("gate %j → invalid-argument invalid_gate", async (gate) => {
    const admin = await mintIdToken({ platformAdmin: true })
    const err = await httpsErrorOf(recordGatePassHandler(await req(admin.token, { gate, evidence: EVIDENCE })))
    expectHttps(err, "invalid-argument", "invalid_gate")
    expect((await gatesRef().get()).exists).toBe(false)
  })

  it.each([
    ["missing", undefined],
    ["a string", "passed"],
    ["empty summary", { summary: "  " }],
    ["summary too long", { summary: "x".repeat(2001) }],
    ["bad commitSha", { summary: "ok", commitSha: "not-a-sha" }],
    ["non-https runUrl", { summary: "ok", runUrl: "http://example.test/run/1" }],
    ["unknown key", { summary: "ok", extra: true }],
  ])("evidence %s → invalid-argument invalid_evidence", async (_label, evidence) => {
    const admin = await mintIdToken({ platformAdmin: true })
    const err = await httpsErrorOf(recordGatePassHandler(await req(admin.token, { gate: "G-2", evidence })))
    expectHttps(err, "invalid-argument", "invalid_evidence")
    expect((await gatesRef().get()).exists).toBe(false)
  })

  it("accepts an https runUrl and a 40-char commitSha", async () => {
    const admin = await mintIdToken({ platformAdmin: true })
    const evidence = { summary: "ok", commitSha: "a".repeat(40), runUrl: "https://github.com/o/r/actions/runs/1" }
    await recordGatePassHandler(await req(admin.token, { gate: "G-2", evidence }))
    expect((await gatesRef().get()).data()?.g2Evidence).toEqual(evidence)
  })
})

describe.skipIf(!EMULATORS)("onboardFirm under R-5 (second firm needs a recorded G-2 pass)", () => {
  const ACTION = "identity.onboardFirm"

  beforeEach(async () => {
    await bootstrapRef().delete()
    await gatesRef().delete()
  })

  it("platformAdmin, first firm exists, no G-2 pass → failed-precondition second_firm_forbidden; no firm, no claims, one deny row", async () => {
    await firstFirmExists()
    const { uid, token } = await mintIdToken({ platformAdmin: true })
    const firmsBefore = (await adminDb().collection("firms").count().get()).data().count
    const err = await httpsErrorOf(onboardFirmHandler(await req(token, { name: "Second" })))
    expectHttps(err, "failed-precondition", "second_firm_forbidden")
    expect((await adminDb().collection("firms").count().get()).data().count).toBe(firmsBefore)
    expect((await adminAuth().getUser(uid)).customClaims).toEqual({ platformAdmin: true })
    expect((await adminDb().collection("users").doc(uid).get()).exists).toBe(false)
    const rows = await auditRows(uid, ACTION)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "deny", reason: "second_firm_forbidden", target: "platform/gates" })
  })

  it.each([
    ["g2PassedAt missing", { g2PassedBy: "someone" }],
    ["g2PassedAt a string", { g2PassedAt: "2026-09-30T00:00:00Z" }],
    ["g2PassedAt true", { g2PassedAt: true }],
  ])("a gates doc with %s does not open the gate", async (_label, doc) => {
    await firstFirmExists()
    await gatesRef().set(doc)
    const { token } = await mintIdToken({ platformAdmin: true })
    const err = await httpsErrorOf(onboardFirmHandler(await req(token, { name: "Second" })))
    expectHttps(err, "failed-precondition", "second_firm_forbidden")
  })

  it("after recordGatePass({ gate: 'G-2' }) the platformAdmin may onboard the second firm", async () => {
    await firstFirmExists()
    const admin = await mintIdToken({ platformAdmin: true })
    await recordGatePassHandler(await req(admin.token, { gate: "G-2", evidence: EVIDENCE }))
    const res = (await onboardFirmHandler(await req(admin.token, { name: "Second" }))) as { firmId: string }
    expect((await adminDb().collection("firms").doc(res.firmId).get()).data()?.name).toBe("Second")
    expect((await bootstrapRef().get()).data()?.firstFirmId).not.toBe(res.firmId)
  })

  it("the very first firm needs no gate pass (platformAdmin on a fresh platform)", async () => {
    const { token } = await mintIdToken({ platformAdmin: true })
    await expect(onboardFirmHandler(await req(token, { name: "Only" }))).resolves.toHaveProperty("firmId")
  })

  it("HTTP api: POST onboardFirm as platformAdmin without a G-2 pass → 409 second_firm_forbidden", async () => {
    await firstFirmExists()
    const { token } = await mintIdToken({ platformAdmin: true })
    const out = { status: 0, body: undefined as unknown }
    const res = {
      status(n: number) {
        out.status = n
        return res
      },
      set() {
        return res
      },
      json(b: unknown) {
        out.body = b
        return res
      },
    }
    const body = { name: "Second via HTTP" }
    await createRouter(ROUTES)(
      {
        method: "POST",
        path: "/api/platform/identity/onboardFirm",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": crypto.randomUUID(),
          "x-forwarded-for": `10.0.0.1, 10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        },
        body,
        rawBody: Buffer.from(JSON.stringify(body)),
        ip: "127.0.0.1",
      } as never,
      res as never
    )
    expect(out).toEqual({ status: 409, body: { error: { code: "second_firm_forbidden" } } })
  })

  it("a founder resume is not a second firm (bootstrap_resume still works without a G-2 pass)", async () => {
    const founder = await mintIdToken(null)
    const first = (await onboardFirmHandler(await req(founder.token, { name: "First" }))) as { firmId: string }
    await adminAuth().setCustomUserClaims(founder.uid, {})
    const again = (await onboardFirmHandler(await req(founder.token, { name: "First" }))) as { firmId: string }
    expect(again.firmId).toBe(first.firmId)
  })
})
