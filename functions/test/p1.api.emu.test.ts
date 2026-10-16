import { randomUUID } from "node:crypto"
import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import { logger } from "firebase-functions"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setProviderConfigForTests } from "@/platform/p1/providerPolicy"
import { adminDb } from "../src/admin"
import { alertRef, firmConfigRef, monthRef, platformConfigRef } from "../src/p1/config"
import { p1TestSeam } from "../src/p1/gateway"
import { setOpikFetchForTests } from "../src/p1/opik"
import { p1OpsTestSeam } from "../src/p1/ops"
import { setP1TransportForTests, type P1Transport } from "../src/p1/transport"
import { HttpError } from "../src/http/errors"
import { apiErrorOf, expectKind, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Phase 3d Task 3 (spec P3-60, P3-66, P3-70..P3-72): the five /api/platform/brain routes through the
 * HTTP router, over the Firestore and Auth emulators, with a fake Gateway transport. Each test uses its
 * own firm; `platform/p1` is shared and is deleted after every test. A committeeBrain caller is limited
 * to 10 requests a minute (kind p1), so a test that makes many calls either uses fresh users or a clock
 * that moves a minute per request (`spread`).
 */

const OPUS = "anthropic/claude-opus-5.5"
const T = Date.parse("2026-10-11T10:00:00.000Z") // PKT month 2026-10
const MONTH = "2026-10"
const at = { now: () => T }
const BIG = 1_000_000_000
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type Member = { uid: string; token: string }
type Out = {
  outputId: string
  blocked: boolean
  reason?: string
  text?: string
  classification: string
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number }
  traceId: string
}
type KillView = { disableAll: boolean; disabledModels: string[]; reason: string; setBy: string; setAt: string }
type Usage = {
  month: string
  budgetMicroUsd: number | null
  spentMicroUsd: number
  spentPkr: number | null
  pkrPerUsd: number | null
  percentUsed: number | null
  calls: { ok: number; failed: number; blocked: number; reconciled: number }
  inputTokens: number
  outputTokens: number
  alerts: Array<{ threshold: number; at: string }>
  killSwitch: { firm: KillView | null; platform: KillView | null }
}

/** A clock that moves a minute per request: the per-user, per-minute rate limit never trips. */
function spread() {
  let ms = T
  return { now: () => (ms += 61_000) }
}

const brainAt = viaApi<Out>("committeeBrain", at)
const brainSpread = viaApi<Out>("committeeBrain", spread())
const usageAt = viaApi<Usage>("getAiUsage", at)
const setBudgetApi = viaApi<{ monthlyBudgetMicroUsd: number; pkrPerUsd: number | null }>("setBudgetAlerts", at)
const setFirmKillApi = viaApi<Record<string, unknown>>("setAiKillSwitch", at)
const setPlatformKillApi = viaApi<Record<string, unknown>>("setPlatformAiKillSwitch", at)

const send = (api: (c: never) => Promise<unknown>, m: Member, data: Record<string, unknown>) => api({ token: m.token, data } as never)
const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })

type Firm = {
  firmId: string
  matterId: string
  P: Member
  A: Member
  C: Member
  intern: Member
  accounts: Member
  client: Member
  /** A partner of the firm who is not a member of the matter. */
  outsider: Member
}

type FirmOpts = { matterClassification?: string; budget?: number | null; parties?: Array<Record<string, unknown>> }

async function addMember(firmId: string, matterId: string, uid: string): Promise<void> {
  await adminDb().collection("matter_members").doc(`${matterId}_${uid}`).set({ firmId, matterId, userId: uid, classification: "internal" })
}

async function seedMatter(firmId: string, classification: string, parties: Array<Record<string, unknown>> = []): Promise<string> {
  const matterId = uniq("matter")
  await adminDb().collection("matters").doc(matterId).set({ firmId, classification, title: "Recovery suit", stage: "pre_filing", status: "open", createdAt: Timestamp.now() })
  for (const party of parties) {
    await adminDb().collection("matter_parties").doc().set({ firmId, matterId, role: "opposing", classification, matterStatus: "live", ...party })
  }
  return matterId
}

async function newFirm(o: FirmOpts = {}): Promise<Firm> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  if (o.budget !== null) await firmConfigRef(firmId).set({ monthlyBudgetMicroUsd: o.budget ?? BIG })
  const matterId = await seedMatter(firmId, o.matterClassification ?? "internal", o.parties)
  const mint = async (role: string, member = true): Promise<Member> => {
    const m = await mintIdToken(claims(firmId, role))
    if (member) await addMember(firmId, matterId, m.uid)
    return m
  }
  const [P, A, C, intern, accounts, client, outsider] = [
    await mint("partner"),
    await mint("associate"),
    await mint("clerk"),
    await mint("intern"),
    await mint("accounts"),
    await mint("client"),
    await mint("partner", false),
  ]
  return { firmId, matterId, P, A, C, intern, accounts, client, outsider }
}

/** A member of the firm's matter with the given role and clearance. */
async function memberOf(f: Firm, role: string, clearance: string): Promise<Member> {
  const m = await mintIdToken(claims(f.firmId, role, clearance))
  await addMember(f.firmId, f.matterId, m.uid)
  return m
}

type Sent = { model: string; body: string; maxTokens: number }

/** A fake Gateway transport that records what it is sent; the default reply costs 14000 micro-USD (1000 in, 500 out). */
function fakeTransport(reply: { text?: string } | (() => Promise<never>) = {}): Sent[] {
  const sent: Sent[] = []
  const t: P1Transport = {
    async send(r) {
      sent.push({ ...r })
      if (typeof reply === "function") return reply()
      return { text: reply.text ?? "REPLY", inputTokens: 1000, outputTokens: 500 }
    },
  }
  setP1TransportForTests(t)
  return sent
}

const docs = async (collection: string, firmId: string): Promise<Array<{ id: string; data: DocumentData }>> =>
  (await adminDb().collection(collection).where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, data: d.data() }))
const outputsOf = (firmId: string) => docs("committee_outputs", firmId)
const usageRowsOf = (firmId: string) => docs("ai_usage_logs", firmId)
const configOf = async (firmId: string) => (await firmConfigRef(firmId).get()).data()
const auditOf = async (actorId: string, action: string) =>
  (await adminDb().collection("audit_log").where("actorId", "==", actorId).where("action", "==", action).get()).docs.map((d) => d.data())

/** Every call made to any logger method, as JSON, for the "no raw text in a log line" check. */
function spyLogs(): () => string {
  const spies = (["debug", "info", "log", "warn", "error", "write"] as const).map((m) => [m, vi.spyOn(logger, m).mockImplementation(() => undefined)] as const)
  return () => JSON.stringify(spies.map(([m, s]) => [m, s.mock.calls]))
}

function resetSeam() {
  for (const k of Object.keys(p1TestSeam)) delete (p1TestSeam as Record<string, unknown>)[k]
  for (const k of Object.keys(p1OpsTestSeam)) delete (p1OpsTestSeam as Record<string, unknown>)[k]
}

describe.skipIf(!EMULATORS)("the /api/platform/brain routes (P3-60, P3-66, P3-70..P3-72)", () => {
  beforeEach(() => {
    vi.stubEnv("OPIK_BASE_URL", undefined)
    vi.stubEnv("OPIK_SELF_HOSTED_CONFIRMED", undefined)
    vi.stubEnv("AI_GATEWAY_API_KEY", undefined)
    setProviderConfigForTests(null)
    resetSeam()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    setP1TransportForTests(null)
    setOpikFetchForTests(null)
    setProviderConfigForTests(null)
    resetSeam()
    await platformConfigRef().delete()
  })

  describe("committeeBrain: input checks (P3-70)", () => {
    const LONG = "x".repeat(100_001)
    // [name, a patch on the valid request (undefined removes the field), the code]
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["matterId missing", { matterId: undefined }, "matter_required"],
      ["matterId empty", { matterId: "" }, "matter_required"],
      ["matterId not a string", { matterId: 5 }, "matter_required"],
      ["body missing", { body: undefined }, "invalid_body"],
      ["body empty", { body: "" }, "invalid_body"],
      ["body not a string", { body: 5 }, "invalid_body"],
      ["body null", { body: null }, "invalid_body"],
      ["body over 100,000 characters", { body: LONG }, "invalid_body"],
      ["purpose outside the list", { purpose: "chat" }, "invalid_purpose"],
      ["purpose not a string", { purpose: 5 }, "invalid_purpose"],
      ["purpose null", { purpose: null }, "invalid_purpose"],
      ["classification not a label", { classification: "secret" }, "invalid_classification"],
      ["classification not a string", { classification: 3 }, "invalid_classification"],
      ["classification an Object.prototype key", { classification: "constructor" }, "invalid_classification"],
      ["classification null", { classification: null }, "invalid_classification"],
      ["documentIds empty array", { documentIds: [] }, "documents_not_supported"],
      ["documentIds with ids", { documentIds: ["d1"] }, "documents_not_supported"],
      ["documentIds null", { documentIds: null }, "documents_not_supported"],
      ["partyNames over 50 entries", { partyNames: Array.from({ length: 51 }, (_, i) => `Party ${i}`) }, "invalid_party_names"],
      ["partyNames with a non-string", { partyNames: ["Ali", 5] }, "invalid_party_names"],
      ["partyNames with an empty string", { partyNames: ["Ali", ""] }, "invalid_party_names"],
      ["partyNames with a whitespace-only entry", { partyNames: ["Ali", "   "] }, "invalid_party_names"],
      ["partyNames with a tab-and-newline entry", { partyNames: ["\t\n"] }, "invalid_party_names"],
      ["partyNames not an array", { partyNames: "Ali Raza" }, "invalid_party_names"],
      ["partyNames null", { partyNames: null }, "invalid_party_names"],
    ]

    it.each(cases)("%s → 400 %s", async (_name, patch, code) => {
      const f = await newFirm()
      const sent = fakeTransport()
      const data = { firmId: f.firmId, matterId: f.matterId, body: "Draft a reply.", ...patch }
      expectKind(await apiErrorOf(send(brainSpread, f.P, data)), "invalid-argument", code)
      expect(sent).toHaveLength(0)
      expect(await usageRowsOf(f.firmId)).toHaveLength(0)
      expect(await outputsOf(f.firmId)).toHaveLength(0)
    })

    it("the checks run in the stated order: matter, body, purpose, classification, documents, party names", async () => {
      const f = await newFirm()
      fakeTransport()
      const bad: Record<string, unknown> = {
        firmId: f.firmId,
        matterId: undefined,
        body: "",
        purpose: "chat",
        classification: "secret",
        documentIds: [],
        partyNames: "Ali",
      }
      const order: Array<[string, unknown, string]> = [
        ["matterId", f.matterId, "matter_required"],
        ["body", "Draft a reply.", "invalid_body"],
        ["purpose", "summarise", "invalid_purpose"],
        ["classification", "internal", "invalid_classification"],
        ["documentIds", undefined, "documents_not_supported"],
        ["partyNames", ["Ali Raza"], "invalid_party_names"],
      ]
      for (const [field, fix, code] of order) {
        expectKind(await apiErrorOf(send(brainSpread, f.P, bad)), "invalid-argument", code)
        bad[field] = fix
      }
      expect(await send(brainSpread, f.P, bad)).toMatchObject({ blocked: false })
    })

    it("the checks come before the permission: an intern with a bad purpose gets 400, not 403", async () => {
      const f = await newFirm()
      expectKind(await apiErrorOf(send(brainSpread, f.intern, { firmId: f.firmId, matterId: f.matterId, body: "x", purpose: "chat" })), "invalid-argument", "invalid_purpose")
    })

    it("the boundaries are accepted: a 100,000-character body, 50 party names, every listed purpose, every label", async () => {
      const f = await newFirm()
      const sent = fakeTransport()
      const base = { firmId: f.firmId, matterId: f.matterId }
      expect(await send(brainSpread, f.P, { ...base, body: "x".repeat(100_000) })).toMatchObject({ blocked: false })
      expect(await send(brainSpread, f.P, { ...base, body: "Draft.", partyNames: Array.from({ length: 50 }, (_, i) => `Party ${i}`) })).toMatchObject({ blocked: false })
      for (const purpose of ["committee-brain", "summarise", "research", "translate", "ops-audit"]) {
        expect(await send(brainSpread, f.P, { ...base, body: "Draft.", purpose })).toMatchObject({ blocked: false })
      }
      for (const classification of ["public", "internal"]) {
        expect(await send(brainSpread, f.P, { ...base, body: "Draft.", classification })).toMatchObject({ blocked: false, classification: "internal" })
      }
      expect(sent).toHaveLength(1 + 1 + 5 + 2)
    })
  })

  describe("committeeBrain: access (P3-70)", () => {
    const data = (f: Firm, extra: Record<string, unknown> = {}) => ({ firmId: f.firmId, matterId: f.matterId, body: "Draft a reply.", ...extra })

    it("partner, associate and clerk members reach the gateway", async () => {
      const f = await newFirm()
      const sent = fakeTransport()
      for (const m of [f.P, f.A, f.C]) expect(await send(brainAt, m, data(f))).toMatchObject({ blocked: false, classification: "internal" })
      expect(sent).toHaveLength(3)
    })

    it("an intern, a client and accounts are refused 403, and a partner who is not a member of the matter too; nothing is called or written", async () => {
      const f = await newFirm()
      const sent = fakeTransport()
      expectKind(await apiErrorOf(send(brainAt, f.intern, data(f))), "permission-denied", "role_not_permitted")
      expectKind(await apiErrorOf(send(brainAt, f.client, data(f))), "permission-denied", "client_denied")
      expectKind(await apiErrorOf(send(brainAt, f.accounts, data(f))), "permission-denied", "accounts_register_only")
      expectKind(await apiErrorOf(send(brainAt, f.outsider, data(f))), "permission-denied", "not_member")
      expect(sent).toHaveLength(0)
      expect(await usageRowsOf(f.firmId)).toHaveLength(0)
      expect(await outputsOf(f.firmId)).toHaveLength(0)
    })

    it("a missing matter and another firm's matter are both 404 not_found (existence never leaks)", async () => {
      const f = await newFirm()
      const other = await newFirm()
      fakeTransport()
      expectKind(await apiErrorOf(send(brainAt, f.P, data(f, { matterId: "no-such-matter" }))), "not-found", "not_found")
      expectKind(await apiErrorOf(send(brainAt, f.P, data(f, { matterId: other.matterId }))), "not-found", "not_found")
      expect(await usageRowsOf(other.firmId)).toHaveLength(0)
    })

    it("a malformed matter id is refused, not queried", async () => {
      const f = await newFirm()
      fakeTransport()
      expectKind(await apiErrorOf(send(brainAt, f.P, data(f, { matterId: "a/b" }))), "permission-denied", "invalid_matter_id")
    })

    it("clearance below the matter's own label is 403 clearance", async () => {
      const f = await newFirm({ matterClassification: "privileged" })
      const sent = fakeTransport()
      const low = await memberOf(f, "associate", "confidential")
      expectKind(await apiErrorOf(send(brainAt, low, data(f))), "permission-denied", "clearance")
      expect(sent).toHaveLength(0)
    })

    it("clearance below the derived classification is 403 clearance: a caller label above it, or the internal floor over a public clearance", async () => {
      const pub = await newFirm({ matterClassification: "public" })
      const sent = fakeTransport()
      const internalCaller = await memberOf(pub, "associate", "internal")
      const publicCaller = await memberOf(pub, "associate", "public")
      expectKind(await apiErrorOf(send(brainAt, internalCaller, data(pub, { classification: "confidential" }))), "permission-denied", "clearance")
      expectKind(await apiErrorOf(send(brainAt, publicCaller, data(pub))), "permission-denied", "clearance")
      expect(await send(brainAt, internalCaller, data(pub))).toMatchObject({ blocked: false, classification: "internal" })
      expect(sent).toHaveLength(1)
      expect(await usageRowsOf(pub.firmId)).toHaveLength(1)
    })

    it("a refusal is audited as a deny under ai.call, a success as an allow", async () => {
      const f = await newFirm()
      fakeTransport()
      await apiErrorOf(send(brainAt, f.intern, data(f)))
      await send(brainAt, f.P, data(f))
      expect((await auditOf(f.intern.uid, "ai.call")).map((r) => [r.decision, r.reason]).sort()).toEqual([
        ["deny", "role-not-permitted"],
        ["deny", "role_not_permitted"],
      ])
      const allows = (await auditOf(f.P.uid, "ai.call")).filter((r) => r.target === `matters/${f.matterId}`)
      expect(allows.map((r) => [r.firmId, r.decision, r.reason])).toEqual([
        [f.firmId, "allow", "ok"],
        [f.firmId, "allow", "ok"],
      ])
    })
  })

  describe("committeeBrain: classification (P3-70: matter, caller label, internal floor)", () => {
    it("an internal matter with no label goes to internal and out", async () => {
      const f = await newFirm()
      const sent = fakeTransport()
      const r = await send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft." }) as Out
      expect(r).toMatchObject({ blocked: false, classification: "internal" })
      expect(sent).toHaveLength(1)
      expect((await usageRowsOf(f.firmId))[0]!.data).toMatchObject({ classification: "internal", outcome: "ok" })
    })

    it("a public matter is floored to internal", async () => {
      const f = await newFirm({ matterClassification: "public" })
      fakeTransport()
      expect(await send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft." })).toMatchObject({ blocked: false, classification: "internal" })
      expect((await outputsOf(f.firmId))[0]!.data.classification).toBe("internal")
    })

    it("a caller label above the matter's raises it: confidential on an internal matter is blocked policy_denied with no DPA", async () => {
      const f = await newFirm()
      const sent = fakeTransport()
      const r = await send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft.", classification: "confidential" }) as Out
      expect(r).toMatchObject({ blocked: true, reason: "policy_denied", classification: "confidential", usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } })
      expect(r).not.toHaveProperty("text")
      expect(sent).toHaveLength(0)
      expect((await usageRowsOf(f.firmId))[0]!.data).toMatchObject({ classification: "confidential", outcome: "blocked", blockReason: "policy_denied" })
    })

    it("a caller label below the matter's never lowers it: public or internal on a confidential matter stays confidential", async () => {
      const f = await newFirm({ matterClassification: "confidential" })
      const sent = fakeTransport()
      for (const classification of ["public", "internal"]) {
        expect(await send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft.", classification })).toMatchObject({ blocked: true, reason: "policy_denied", classification: "confidential" })
      }
      expect(sent).toHaveLength(0)
    })

    it("with a DPA executed, a confidential call goes out", async () => {
      const f = await newFirm({ matterClassification: "confidential" })
      const sent = fakeTransport()
      setProviderConfigForTests({ "ai-gateway": { dpaExecuted: true, inRegion: false } })
      expect(await send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft." })).toMatchObject({ blocked: false, classification: "confidential" })
      expect(sent).toHaveLength(1)
    })
  })

  describe("committeeBrain: masking (Review Focus 1)", () => {
    const RAW = ["Ali Raza Khan", "Zubair Hashmi", "Haris Qalbani", "35202-1234567-1", "0300-1234567"]
    const leaks = (s: string) => RAW.filter((raw) => s.toLowerCase().includes(raw.toLowerCase()))

    it("the matter's party names (name and names) and the supplied ones are masked in what the transport receives, in the stored output and in the reply; none reaches a row, an event, an audit row or a log line", async () => {
      const f = await newFirm({
        parties: [
          { role: "client", name: "Ali Raza Khan", names: ["ali raza khan", "ali raza"] },
          { role: "opposing", name: "Zubair Hashmi", names: ["zubair hashmi"] },
        ],
      })
      const logs = spyLogs()
      const sent = fakeTransport({ text: "Reply: ali raza khan and Haris Qalbani may call 0300-1234567; zubair hashmi agrees." })
      const r = await send(brainAt, f.P, {
        firmId: f.firmId,
        matterId: f.matterId,
        body: "Client Ali Raza Khan (CNIC 35202-1234567-1, mobile 0300-1234567) v. Zubair Hashmi and Haris Qalbani.",
        partyNames: ["Haris Qalbani"],
      }) as Out

      expect(sent).toHaveLength(1)
      expect(leaks(sent[0]!.body)).toEqual([])
      expect(sent[0]!.body).toContain("[PARTY]")
      expect(r.text).toBeDefined()
      expect(leaks(r.text!)).toEqual([])

      const [stored] = await outputsOf(f.firmId)
      expect(leaks(JSON.stringify(stored!.data))).toEqual([])
      expect(stored!.data.outbound.body).toBe(sent[0]!.body)

      const everything = JSON.stringify([
        await usageRowsOf(f.firmId),
        await docs("events", f.firmId),
        await docs("audit_log", f.firmId),
        await docs("committee_outputs", f.firmId),
      ])
      expect(leaks(everything)).toEqual([])
      expect(leaks(logs())).toEqual([])
    })

    it("overlapping names are masked longest first: no surname is left behind", async () => {
      const f = await newFirm({ parties: [{ name: "Ali Raza", names: ["ali raza"] }] })
      const sent = fakeTransport()
      await send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Ali Raza Khan signed.", partyNames: ["Ali Raza Khan"] })
      expect(sent[0]!.body).toBe("[PARTY] signed.")
    })

    it("only this firm's party rows for this matter count: another firm's rows on the same matter id are ignored", async () => {
      const f = await newFirm()
      await adminDb().collection("matter_parties").doc().set({ firmId: uniq("elsewhere"), matterId: f.matterId, name: "Zubair Hashmi", names: ["zubair hashmi"] })
      const sent = fakeTransport()
      await send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Zubair Hashmi appeared." })
      expect(sent[0]!.body).toBe("Zubair Hashmi appeared.")
    })
  })

  describe("committeeBrain: output (P3-70)", () => {
    const base = (f: Firm, extra: Record<string, unknown> = {}) => ({ firmId: f.firmId, matterId: f.matterId, body: "Draft a reply to the notice.", ...extra })

    it("an ok call: the response, the committee_outputs row, the usage row and the allow audit row", async () => {
      const f = await newFirm({ parties: [{ name: "Ali Raza", names: ["ali raza"] }] })
      const sent = fakeTransport({ text: "Reply for Ali Raza" })
      const r = await send(brainAt, f.P, base(f, { body: "Draft for Ali Raza, 0300-1234567.", purpose: "summarise" })) as Out

      expect(Object.keys(r).sort()).toEqual(["accounting", "blocked", "classification", "outputId", "text", "traceId", "usage"])
      expect(r).toMatchObject({ blocked: false, accounting: "settled", text: "Reply for [PARTY]", classification: "internal", usage: { inputTokens: 1000, outputTokens: 500, costMicroUsd: 14000 } })
      expect(r.traceId).toMatch(UUID_V7)
      expect(sent).toEqual([{ model: OPUS, body: "Draft for [PARTY], [PHONE].", maxTokens: 4096 }])

      const outputs = await outputsOf(f.firmId)
      expect(outputs).toHaveLength(1)
      expect(outputs[0]!.id).toBe(r.outputId)
      const row = outputs[0]!.data
      expect(Object.keys(row).sort()).toEqual(
        ["accounting", "actorId", "blocked", "classification", "createdAt", "documentIds", "firmId", "id", "matterId", "outbound", "purpose", "text", "traceId", "usageLogId"].sort()
      )
      expect(row).toMatchObject({
        id: r.outputId,
        firmId: f.firmId,
        actorId: f.P.uid,
        matterId: f.matterId,
        documentIds: [],
        classification: "internal",
        purpose: "summarise",
        blocked: false,
        accounting: "settled",
        text: "Reply for [PARTY]",
        traceId: r.traceId,
        outbound: { body: sent[0]!.body, metadata: { classification: "internal", provider: "ai-gateway", purpose: "summarise" } },
      })
      expect(row.outbound.metadata.redactionCounts).toEqual({ cnic: 0, phone: 1, party: 1, email: 0, iban: 0, ntn: 0, passport: 0 })
      expect(Object.keys(row.outbound).sort()).toEqual(["body", "metadata"])
      // Audit F15: the residual detector's counts on the masked body sit beside the mask's own.
      expect(row.outbound.metadata.residualCounts).toEqual({ id_digits: 0, labelled_identifier: 0, address: 0, kinship_name: 0 })
      expect(Object.keys(row.outbound.metadata).sort()).toEqual(["classification", "provider", "purpose", "redactionCounts", "residualCounts"])
      // The Next.js CommitteeBrainOutput shape: epoch milliseconds from the op's clock (T plus the time the call took).
      expect(typeof row.createdAt).toBe("number")
      expect(Number.isInteger(row.createdAt)).toBe(true)
      expect(row.createdAt).toBeGreaterThanOrEqual(T)
      expect(row.createdAt).toBeLessThan(T + 60_000)

      const [usage] = await usageRowsOf(f.firmId)
      expect(usage!.id).toBe(row.usageLogId)
      expect(usage!.data).toMatchObject({ actorId: f.P.uid, matterId: f.matterId, outcome: "ok", costMicroUsd: 14000, trace: { id: r.traceId } })
    })

    it("the purpose defaults to committee-brain", async () => {
      const f = await newFirm()
      fakeTransport()
      await send(brainAt, f.P, base(f))
      expect((await outputsOf(f.firmId))[0]!.data).toMatchObject({ purpose: "committee-brain", outbound: { metadata: { purpose: "committee-brain" } } })
    })

    it("a blocked call is stored and returned with its reason and no text", async () => {
      const f = await newFirm({ budget: null })
      const sent = fakeTransport()
      const r = await send(brainAt, f.P, base(f)) as Out
      expect(Object.keys(r).sort()).toEqual(["accounting", "blocked", "classification", "outputId", "reason", "traceId", "usage"])
      expect(r).toMatchObject({ blocked: true, accounting: "settled", reason: "budget_not_set", usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } })
      expect(sent).toHaveLength(0)
      const row = (await outputsOf(f.firmId))[0]!.data
      expect(row).toMatchObject({ blocked: true, reason: "budget_not_set", outbound: { body: "Draft a reply to the notice." } })
      expect(row).not.toHaveProperty("text")
      expect(row.usageLogId).toBe((await usageRowsOf(f.firmId))[0]!.id)
    })

    it("a transport failure is stored and returned as blocked with reason transport_error, no text, and no provider text anywhere", async () => {
      const f = await newFirm()
      const logs = spyLogs()
      fakeTransport(async () => {
        throw new Error("provider said: secret detail for Ali Raza")
      })
      const r = await send(brainAt, f.P, base(f)) as Out
      expect(r).toMatchObject({ blocked: true, reason: "transport_error", usage: { costMicroUsd: 0 } })
      expect(r).not.toHaveProperty("text")
      const row = (await outputsOf(f.firmId))[0]!.data
      expect(row).toMatchObject({ blocked: true, reason: "transport_error" })
      expect(row).not.toHaveProperty("text")
      expect((await usageRowsOf(f.firmId))[0]!.data).toMatchObject({ outcome: "failed", blockReason: null })
      expect(logs()).not.toContain("secret detail")
      expect(JSON.stringify(r)).not.toContain("secret detail")
    })

    it("replaying the same Idempotency-Key returns the same answer with no second transport call, usage row or output row", async () => {
      const f = await newFirm()
      const sent = fakeTransport()
      const headers = { "idempotency-key": randomUUID() }
      const call = () => brainAt({ token: f.P.token, data: base(f), headers } as never)
      const first = await call()
      const second = await call()
      // The router marks a replay with `reused: true` and returns the stored answer otherwise unchanged.
      expect(second).toEqual({ ...first, reused: true })
      expect(sent).toHaveLength(1)
      expect(await usageRowsOf(f.firmId)).toHaveLength(1)
      expect(await outputsOf(f.firmId)).toHaveLength(1)
      const month = (await monthRef(f.firmId, MONTH).get()).data()
      expect(month).toMatchObject({ spentMicroUsd: 14000, calls: { ok: 1, failed: 0, blocked: 0 } })
    })

    describe("the output write is retried", () => {
      const ask = (f: Firm) => send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft a reply to the notice." })
      const permissionAndCallRows = async (f: Firm) =>
        (await auditOf(f.P.uid, "ai.call")).filter((r) => r.target === `matters/${f.matterId}` && r.decision === "allow")

      it("a transient failure of the first two attempts still gives one row, one allow audit row, one provider call, after waits of 100 and 200 ms", async () => {
        const baseline = await newFirm()
        fakeTransport()
        await ask(baseline)
        const normalRows = (await permissionAndCallRows(baseline)).length

        const f = await newFirm()
        const sent = fakeTransport()
        const waits: number[] = []
        p1OpsTestSeam.sleep = async (ms) => void waits.push(ms)
        p1OpsTestSeam.outputWriteFailures = [new Error("transient one"), new Error("transient two")]
        const r = (await ask(f)) as Out
        expect(waits).toEqual([100, 200])
        expect(p1OpsTestSeam.outputWriteFailures).toEqual([])
        expect(sent).toHaveLength(1)
        const outputs = await outputsOf(f.firmId)
        expect(outputs.map((o) => o.id)).toEqual([r.outputId])
        expect(await usageRowsOf(f.firmId)).toHaveLength(1)
        // The same audit rows as a call that needed no retry: the failed attempts staged nothing.
        expect((await permissionAndCallRows(f)).length).toBe(normalRows)
        expect(await docs("audit_log", f.firmId).then((rows) => rows.filter((a) => a.data.action === "ai.gateway.decision"))).toHaveLength(1)
      })

      it("after the third failure it rethrows as before: 500 internal, one provider call and its usage row, no output row, a deny audit row", async () => {
        const f = await newFirm()
        const sent = fakeTransport()
        const waits: number[] = []
        p1OpsTestSeam.sleep = async (ms) => void waits.push(ms)
        p1OpsTestSeam.outputWriteFailures = [new Error("down"), new Error("down"), new Error("down")]
        const err = await apiErrorOf(ask(f))
        expect({ status: err.status, code: err.code }).toEqual({ status: 500, code: "internal" })
        expect(waits).toEqual([100, 200])
        expect(sent).toHaveLength(1)
        expect(await usageRowsOf(f.firmId)).toHaveLength(1)
        expect(await outputsOf(f.firmId)).toHaveLength(0)
        expect((await auditOf(f.P.uid, "ai.call")).filter((r) => r.decision === "deny" && r.reason === "internal")).toHaveLength(1)
      })

      it("no attempt starts after the output write's deadline: it rethrows with the remaining injected failures unused (Codex P1 on PR #40)", async () => {
        const f = await newFirm()
        const sent = fakeTransport()
        const waits: number[] = []
        p1OpsTestSeam.sleep = async (ms) => void waits.push(ms)
        p1OpsTestSeam.outputWriteFailures = [new Error("down"), new Error("down"), new Error("down")]
        // The deadline's clock: the first read starts the window, the next is already past it.
        const reads = [0, 60_000]
        p1OpsTestSeam.wallClock = () => reads.shift() ?? 60_000
        const err = await apiErrorOf(ask(f))
        expect({ status: err.status, code: err.code }).toEqual({ status: 500, code: "internal" })
        expect(waits).toEqual([])
        expect(p1OpsTestSeam.outputWriteFailures).toHaveLength(2)
        expect(sent).toHaveLength(1)
        expect(await outputsOf(f.firmId)).toHaveLength(0)
      })

      it("an ambiguous commit (the first attempt commits, its answer is lost, the retry's create hits ALREADY_EXISTS) is a success: 200, one output row, one route allow row and no deny row, one provider call", async () => {
        const f = await newFirm()
        const sent = fakeTransport()
        const waits: number[] = []
        p1OpsTestSeam.sleep = async (ms) => void waits.push(ms)
        // A retryable gRPC code (DEADLINE_EXCEEDED) thrown after the first attempt's transaction has committed.
        p1OpsTestSeam.lostCommitAnswers = [Object.assign(new Error("deadline exceeded"), { code: 4 })]
        const r = (await ask(f)) as Out
        expect(Object.keys(r).sort()).toEqual(["accounting", "blocked", "classification", "outputId", "text", "traceId", "usage"])
        expect(r).toMatchObject({ blocked: false, accounting: "settled", text: "REPLY", usage: { inputTokens: 1000, outputTokens: 500, costMicroUsd: 14000 } })
        expect(waits).toEqual([100])
        expect(p1OpsTestSeam.lostCommitAnswers).toEqual([])
        expect(sent).toHaveLength(1)
        const outputs = await outputsOf(f.firmId)
        expect(outputs.map((o) => o.id)).toEqual([r.outputId])
        expect(outputs[0]!.data.usageLogId).toBe((await usageRowsOf(f.firmId))[0]!.id)
        // The permission check's allow row and the route's allow row (from the attempt that committed), and no deny row.
        const rows = (await auditOf(f.P.uid, "ai.call")).filter((row) => row.target === `matters/${f.matterId}`)
        expect(rows.map((row) => [row.decision, row.reason])).toEqual([
          ["allow", "ok"],
          ["allow", "ok"],
        ])
        expect(await docs("audit_log", f.firmId).then((all) => all.filter((a) => a.data.action === "ai.gateway.decision"))).toHaveLength(1)
      })

      it("an ALREADY_EXISTS while no output row of this call exists is not taken as a commit: it is retried like any failure", async () => {
        const f = await newFirm()
        fakeTransport()
        const waits: number[] = []
        p1OpsTestSeam.sleep = async (ms) => void waits.push(ms)
        p1OpsTestSeam.outputWriteFailures = [Object.assign(new Error("already exists"), { code: 6 })]
        const r = (await ask(f)) as Out
        expect(waits).toEqual([100])
        expect((await outputsOf(f.firmId)).map((o) => o.id)).toEqual([r.outputId])
        expect((await auditOf(f.P.uid, "ai.call")).filter((row) => row.decision === "deny")).toHaveLength(0)
      })

      it("with NODE_ENV production every p1OpsTestSeam field is inert: no injected failure, no lost answer, no wait", async () => {
        const f = await newFirm()
        const sent = fakeTransport()
        const waits: number[] = []
        p1OpsTestSeam.sleep = async (ms) => void waits.push(ms)
        p1OpsTestSeam.outputWriteFailures = [new Error("injected"), new Error("injected"), new Error("injected")]
        p1OpsTestSeam.lostCommitAnswers = [Object.assign(new Error("lost"), { code: 4 })]
        // The output write's deadline clock too (Codex P1): a clock already past the deadline is ignored.
        let clockReads = 0
        p1OpsTestSeam.wallClock = () => (clockReads += 1) * 60_000
        // And the pre-call deadline's clock (re-audit R3-D2): a clock already past the allowance is ignored.
        let preCallReads = 0
        p1OpsTestSeam.preCallClock = () => {
          preCallReads += 1
          return Date.now() + 60_000
        }
        vi.stubEnv("NODE_ENV", "production")
        const r = (await ask(f)) as Out
        expect(r).toMatchObject({ blocked: false, text: "REPLY" })
        expect([clockReads, preCallReads]).toEqual([0, 0])
        expect(waits).toEqual([])
        expect(p1OpsTestSeam.outputWriteFailures).toHaveLength(3)
        expect(p1OpsTestSeam.lostCommitAnswers).toHaveLength(1)
        expect(sent).toHaveLength(1)
        expect((await outputsOf(f.firmId)).map((o) => o.id)).toEqual([r.outputId])
        expect((await auditOf(f.P.uid, "ai.call")).filter((row) => row.decision === "deny")).toHaveLength(0)
      })

      it("an HttpError is a decision, not a transient fault: it is not retried", async () => {
        const f = await newFirm()
        fakeTransport()
        const waits: number[] = []
        p1OpsTestSeam.sleep = async (ms) => void waits.push(ms)
        p1OpsTestSeam.outputWriteFailures = [new HttpError(503, "audit_unavailable")]
        const err = await apiErrorOf(ask(f))
        expect({ status: err.status, code: err.code }).toEqual({ status: 503, code: "audit_unavailable" })
        expect(waits).toEqual([])
        expect(p1OpsTestSeam.outputWriteFailures).toEqual([])
        expect(await outputsOf(f.firmId)).toHaveLength(0)
      })
    })

    it("a different Idempotency-Key is a new call", async () => {
      const f = await newFirm()
      const sent = fakeTransport()
      await send(brainAt, f.P, base(f))
      await send(brainAt, f.P, base(f))
      expect(sent).toHaveLength(2)
      expect(await outputsOf(f.firmId)).toHaveLength(2)
    })
  })

  describe("setBudgetAlerts (P3-71)", () => {
    const setBudget = (f: Firm, m: Member, data: Record<string, unknown>) => send(setBudgetApi, m, { firmId: f.firmId, ...data })

    it("only a partner: associate, clerk, intern, accounts and client are refused 403", async () => {
      const f = await newFirm({ budget: null })
      expectKind(await apiErrorOf(setBudget(f, f.A, { monthlyBudgetUsd: 5 })), "permission-denied", "role_not_permitted")
      expectKind(await apiErrorOf(setBudget(f, f.C, { monthlyBudgetUsd: 5 })), "permission-denied", "role_not_permitted")
      expectKind(await apiErrorOf(setBudget(f, f.intern, { monthlyBudgetUsd: 5 })), "permission-denied", "role_not_permitted")
      expectKind(await apiErrorOf(setBudget(f, f.accounts, { monthlyBudgetUsd: 5 })), "permission-denied", "accounts_register_only")
      expectKind(await apiErrorOf(setBudget(f, f.client, { monthlyBudgetUsd: 5 })), "permission-denied", "client_denied")
      expect(await configOf(f.firmId)).toBeUndefined()
    })

    it("a partner need not be a member of any matter", async () => {
      const f = await newFirm({ budget: null })
      expect(await setBudget(f, f.outsider, { monthlyBudgetUsd: 5 })).toMatchObject({ monthlyBudgetMicroUsd: 5_000_000 })
    })

    it.each([
      ["zero", 0],
      ["negative", -1],
      ["over the cap by a cent", 1000000.01],
      ["three decimal places", 1.001],
      ["float noise (0.1 + 0.2)", 0.1 + 0.2],
      ["a sub-cent number in exponent form", 1e-7],
      ["a string", "5"],
      ["null", null],
      ["missing", undefined],
      ["an object", { usd: 5 }],
    ])("monthlyBudgetUsd %s → 400 invalid_budget; nothing is stored", async (_name, value) => {
      const f = await newFirm({ budget: null })
      expectKind(await apiErrorOf(setBudget(f, f.P, { monthlyBudgetUsd: value })), "invalid-argument", "invalid_budget")
      expect(await configOf(f.firmId)).toBeUndefined()
    })

    it.each([
      ["zero", 0],
      ["negative", -1],
      ["over the cap", 10001],
      ["a string", "280"],
      ["null", null],
    ])("pkrPerUsd %s → 400 invalid_rate; nothing is stored", async (_name, value) => {
      const f = await newFirm({ budget: null })
      expectKind(await apiErrorOf(setBudget(f, f.P, { monthlyBudgetUsd: 5, pkrPerUsd: value })), "invalid-argument", "invalid_rate")
      expect(await configOf(f.firmId)).toBeUndefined()
    })

    it("a bad budget is reported before a bad rate", async () => {
      const f = await newFirm({ budget: null })
      expectKind(await apiErrorOf(setBudget(f, f.P, { monthlyBudgetUsd: 0, pkrPerUsd: 0 })), "invalid-argument", "invalid_budget")
    })

    it.each([
      [1.5, 1_500_000],
      [0.01, 10_000],
      [0.07, 70_000],
      [1.15, 1_150_000],
      [19.99, 19_990_000],
      [250, 250_000_000],
      [1000000, 1_000_000_000_000],
    ])("%s USD is stored as %s micro-USD (an integer)", async (usd, micro) => {
      const f = await newFirm({ budget: null })
      expect(await setBudget(f, f.P, { monthlyBudgetUsd: usd })).toEqual({ monthlyBudgetMicroUsd: micro, pkrPerUsd: null })
      const stored = (await configOf(f.firmId))!
      expect(stored.monthlyBudgetMicroUsd).toBe(micro)
      expect(Number.isSafeInteger(stored.monthlyBudgetMicroUsd)).toBe(true)
      expect(stored).not.toHaveProperty("pkrPerUsd")
    })

    it("pkrPerUsd is stored when given (up to 10,000) and left untouched when omitted", async () => {
      const f = await newFirm({ budget: null })
      expect(await setBudget(f, f.P, { monthlyBudgetUsd: 2, pkrPerUsd: 281.25 })).toEqual({ monthlyBudgetMicroUsd: 2_000_000, pkrPerUsd: 281.25 })
      expect(await configOf(f.firmId)).toMatchObject({ monthlyBudgetMicroUsd: 2_000_000, pkrPerUsd: 281.25 })
      expect(await setBudget(f, f.P, { monthlyBudgetUsd: 3 })).toEqual({ monthlyBudgetMicroUsd: 3_000_000, pkrPerUsd: 281.25 })
      expect(await configOf(f.firmId)).toMatchObject({ monthlyBudgetMicroUsd: 3_000_000, pkrPerUsd: 281.25 })
      expect(await setBudget(f, f.P, { monthlyBudgetUsd: 3, pkrPerUsd: 10000 })).toMatchObject({ pkrPerUsd: 10000 })
    })

    it("it merges: the firm's kill switch is kept, and another firm's config is untouched", async () => {
      const f = await newFirm({ budget: null })
      const g = await newFirm({ budget: 7_000_000 })
      await send(setFirmKillApi, f.P, { firmId: f.firmId, disableAll: true, disabledModels: [], reason: "pause" })
      await setBudget(f, f.P, { monthlyBudgetUsd: 4 })
      expect(await configOf(f.firmId)).toMatchObject({ monthlyBudgetMicroUsd: 4_000_000, killSwitch: { disableAll: true, reason: "pause" } })
      expect(await configOf(g.firmId)).toEqual({ monthlyBudgetMicroUsd: 7_000_000 })
    })

    it("is audited as ai.budget.set (an allow on ai_config/{firmId}; a refused value is a deny)", async () => {
      const f = await newFirm({ budget: null })
      await apiErrorOf(setBudget(f, f.P, { monthlyBudgetUsd: 0 }))
      await setBudget(f, f.P, { monthlyBudgetUsd: 5 })
      const rows = (await auditOf(f.P.uid, "ai.budget.set")).filter((r) => r.target === `ai_config/${f.firmId}`)
      expect(rows.map((r) => [r.firmId, r.decision, r.reason]).sort()).toEqual([
        [f.firmId, "allow", "ok"],
        [f.firmId, "deny", "invalid_budget"],
      ])
    })

    it("a budget set here lets committeeBrain through", async () => {
      const f = await newFirm({ budget: null })
      fakeTransport()
      expect(await send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft." })).toMatchObject({ blocked: true, reason: "budget_not_set" })
      await setBudget(f, f.P, { monthlyBudgetUsd: 5 })
      expect(await send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft." })).toMatchObject({ blocked: false })
    })
  })

  describe("setAiKillSwitch (P3-66)", () => {
    const killFirm = (f: Firm, m: Member, data: Record<string, unknown>) => send(setFirmKillApi, m, { firmId: f.firmId, ...data })
    const OK = { disableAll: true, disabledModels: [], reason: "Provider incident" }

    it("only a partner: associate, clerk, intern, accounts and client are refused 403", async () => {
      const f = await newFirm()
      expectKind(await apiErrorOf(killFirm(f, f.A, OK)), "permission-denied", "role_not_permitted")
      expectKind(await apiErrorOf(killFirm(f, f.C, OK)), "permission-denied", "role_not_permitted")
      expectKind(await apiErrorOf(killFirm(f, f.intern, OK)), "permission-denied", "role_not_permitted")
      expectKind(await apiErrorOf(killFirm(f, f.accounts, OK)), "permission-denied", "accounts_register_only")
      expectKind(await apiErrorOf(killFirm(f, f.client, OK)), "permission-denied", "client_denied")
      expect((await configOf(f.firmId))!.killSwitch).toBeUndefined()
    })

    it.each([
      ["disableAll missing", { disableAll: undefined }],
      ["disableAll a string", { disableAll: "true" }],
      ["disableAll a number", { disableAll: 1 }],
      ["disabledModels missing", { disabledModels: undefined }],
      ["disabledModels not an array", { disabledModels: "a/b" }],
      ["disabledModels over 20", { disabledModels: Array.from({ length: 21 }, (_, i) => `m/${i}`) }],
      ["disabledModels with a non-string", { disabledModels: ["a/b", 5] }],
      ["disabledModels with an empty string", { disabledModels: ["a/b", ""] }],
      ["disabledModels with a model over 200 characters", { disabledModels: ["m".repeat(201)] }],
    ])("%s → 400 invalid_kill_switch; nothing is stored", async (_name, patch) => {
      const f = await newFirm()
      expectKind(await apiErrorOf(killFirm(f, f.P, { ...OK, ...patch })), "invalid-argument", "invalid_kill_switch")
      expect((await configOf(f.firmId))!.killSwitch).toBeUndefined()
    })

    it.each([
      ["missing", undefined],
      ["not a string", 5],
      ["empty", ""],
      ["blank", "   \n "],
      ["501 characters", "r".repeat(501)],
      ["501 characters after trim", ` ${"r".repeat(501)} `],
    ])("reason %s → 400 invalid_reason", async (_name, reason) => {
      const f = await newFirm()
      expectKind(await apiErrorOf(killFirm(f, f.P, { ...OK, reason })), "invalid-argument", "invalid_reason")
      expect((await configOf(f.firmId))!.killSwitch).toBeUndefined()
    })

    it("a bad shape is reported before a bad reason", async () => {
      const f = await newFirm()
      expectKind(await apiErrorOf(killFirm(f, f.P, { disableAll: "yes", disabledModels: [], reason: "" })), "invalid-argument", "invalid_kill_switch")
    })

    it("the boundaries are accepted: a 500-character reason (trimmed), 20 models of 200 characters", async () => {
      const f = await newFirm()
      const models = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(200, "m"))
      await killFirm(f, f.P, { disableAll: false, disabledModels: models, reason: `  ${"r".repeat(500)}  ` })
      const ks = (await configOf(f.firmId))!.killSwitch
      expect(ks.reason).toBe("r".repeat(500))
      expect(ks.disabledModels).toEqual(models)
    })

    it("stores { disableAll, disabledModels, reason, setBy, setAt } in ai_config/{firmId}, beside the budget", async () => {
      const f = await newFirm()
      const out = await killFirm(f, f.P, { disableAll: false, disabledModels: [OPUS], reason: " Cost review " })
      expect(out).toMatchObject({ disableAll: false, disabledModels: [OPUS], reason: "Cost review", setBy: f.P.uid })
      const cfg = (await configOf(f.firmId))!
      expect(cfg.monthlyBudgetMicroUsd).toBe(BIG)
      expect(Object.keys(cfg.killSwitch).sort()).toEqual(["disableAll", "disabledModels", "reason", "setAt", "setBy"])
      expect(cfg.killSwitch).toMatchObject({ disableAll: false, disabledModels: [OPUS], reason: "Cost review", setBy: f.P.uid })
      expect(cfg.killSwitch.setAt).toBeInstanceOf(Timestamp)
    })

    it("a request replaces the whole state: nothing of the earlier switch survives, not even a field this code does not write", async () => {
      const f = await newFirm()
      await killFirm(f, f.P, { disableAll: true, disabledModels: ["a/one", "b/two"], reason: "first" })
      await killFirm(f, f.P, { disableAll: false, disabledModels: ["c/three"], reason: "second" })
      const ks = (await configOf(f.firmId))!.killSwitch
      expect(ks).toMatchObject({ disableAll: false, disabledModels: ["c/three"], reason: "second" })
      await firmConfigRef(f.firmId).update({ "killSwitch.stale": "left over" })
      await killFirm(f, f.P, { disableAll: false, disabledModels: [], reason: "third" })
      const after = (await configOf(f.firmId))!
      expect(Object.keys(after.killSwitch).sort()).toEqual(["disableAll", "disabledModels", "reason", "setAt", "setBy"])
      expect(after.killSwitch).toMatchObject({ disabledModels: [], reason: "third" })
      expect(after.monthlyBudgetMicroUsd).toBe(BIG)
    })

    it("disableAll blocks the next committeeBrain call kill_switch_firm; re-enabling lets the next one through", async () => {
      const f = await newFirm()
      const sent = fakeTransport()
      const call = () => send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft." })
      await killFirm(f, f.P, { disableAll: true, disabledModels: [], reason: "Provider incident" })
      expect(await call()).toMatchObject({ blocked: true, reason: "kill_switch_firm" })
      expect(sent).toHaveLength(0)
      await killFirm(f, f.P, { disableAll: false, disabledModels: [], reason: "Resolved" })
      expect(await call()).toMatchObject({ blocked: false })
      expect(sent).toHaveLength(1)
    })

    it("a disabled model blocks only that model's calls", async () => {
      const f = await newFirm()
      const sent = fakeTransport()
      const call = () => send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft." })
      await killFirm(f, f.P, { disableAll: false, disabledModels: ["other/model"], reason: "Other model" })
      expect(await call()).toMatchObject({ blocked: false })
      await killFirm(f, f.P, { disableAll: false, disabledModels: [OPUS], reason: "This model" })
      expect(await call()).toMatchObject({ blocked: true, reason: "kill_switch_firm" })
      expect(sent).toHaveLength(1)
    })

    it("it stops this firm only", async () => {
      const f = await newFirm()
      const g = await newFirm()
      const sent = fakeTransport()
      await killFirm(f, f.P, OK)
      expect(await send(brainAt, g.P, { firmId: g.firmId, matterId: g.matterId, body: "Draft." })).toMatchObject({ blocked: false })
      expect(sent).toHaveLength(1)
    })

    it("is audited as ai.kill_switch.set", async () => {
      const f = await newFirm()
      await killFirm(f, f.P, OK)
      const rows = (await auditOf(f.P.uid, "ai.kill_switch.set")).filter((r) => r.target === `ai_config/${f.firmId}`)
      expect(rows.map((r) => [r.firmId, r.decision, r.reason])).toEqual([[f.firmId, "allow", "ok"]])
    })
  })

  describe("setPlatformAiKillSwitch (P3-66)", () => {
    const OK = { disableAll: true, disabledModels: [], reason: "Operator stop" }
    const killPlatform = (m: Member, data: Record<string, unknown>) => send(setPlatformKillApi, m, data)
    const admin = () => mintIdToken({ platformAdmin: true })

    it("a caller without the platformAdmin claim gets 403 platform_admin_only, a firm partner included; nothing is stored", async () => {
      const f = await newFirm()
      const flagged = await mintIdToken({ ...claims(f.firmId, "partner"), platformAdmin: "true" })
      expectKind(await apiErrorOf(killPlatform(f.P, { firmId: f.firmId, ...OK })), "permission-denied", "platform_admin_only")
      expectKind(await apiErrorOf(killPlatform(f.P, OK)), "permission-denied", "platform_admin_only")
      expectKind(await apiErrorOf(killPlatform(flagged, OK)), "permission-denied", "platform_admin_only")
      expect((await platformConfigRef().get()).exists).toBe(false)
    })

    it("a refusal is audited as a deny under ai.platform_kill_switch.set with reason platform_admin_only", async () => {
      const f = await newFirm()
      await apiErrorOf(killPlatform(f.P, OK))
      const rows = (await auditOf(f.P.uid, "ai.platform_kill_switch.set")).filter((r) => r.target === "platform/p1")
      expect(rows.map((r) => [r.decision, r.reason])).toEqual([["deny", "platform_admin_only"]])
    })

    it("the claim is checked before the body: a bad body from a non-admin is still 403", async () => {
      const f = await newFirm()
      expectKind(await apiErrorOf(killPlatform(f.P, { disableAll: "x" })), "permission-denied", "platform_admin_only")
    })

    it("with the claim it stores { disableAll, disabledModels, reason, setBy, setAt } at platform/p1 and keeps the doc's other fields", async () => {
      const a = await admin()
      await platformConfigRef().set({ note: "kept" })
      const out = await killPlatform(a, { disableAll: false, disabledModels: [OPUS], reason: " Cost review " })
      expect(out).toMatchObject({ disableAll: false, disabledModels: [OPUS], reason: "Cost review", setBy: a.uid })
      const doc = (await platformConfigRef().get()).data()!
      expect(doc.note).toBe("kept")
      expect(Object.keys(doc.killSwitch).sort()).toEqual(["disableAll", "disabledModels", "reason", "setAt", "setBy"])
      expect(doc.killSwitch).toMatchObject({ disableAll: false, disabledModels: [OPUS], reason: "Cost review", setBy: a.uid })
      expect(doc.killSwitch.setAt).toBeInstanceOf(Timestamp)
    })

    it.each([
      ["disableAll not a boolean", { disableAll: "true" }, "invalid_kill_switch"],
      ["disabledModels not an array", { disabledModels: "a/b" }, "invalid_kill_switch"],
      ["disabledModels over 20", { disabledModels: Array.from({ length: 21 }, (_, i) => `m/${i}`) }, "invalid_kill_switch"],
      ["disabledModels with an empty string", { disabledModels: [""] }, "invalid_kill_switch"],
      ["disabledModels with a model over 200 characters", { disabledModels: ["m".repeat(201)] }, "invalid_kill_switch"],
      ["reason empty", { reason: "  " }, "invalid_reason"],
      ["reason over 500", { reason: "r".repeat(501) }, "invalid_reason"],
    ])("%s → 400 %s", async (_name, patch, code) => {
      const a = await admin()
      expectKind(await apiErrorOf(killPlatform(a, { ...OK, ...patch })), "invalid-argument", code)
      expect((await platformConfigRef().get()).exists).toBe(false)
    })

    it("a request replaces the whole state: nothing of the earlier switch survives, not even a field this code does not write", async () => {
      const a = await admin()
      await killPlatform(a, { disableAll: true, disabledModels: ["a/one"], reason: "first" })
      await platformConfigRef().update({ "killSwitch.stale": "left over" })
      await killPlatform(a, { disableAll: false, disabledModels: [], reason: "second" })
      const ks = (await platformConfigRef().get()).get("killSwitch")
      expect(Object.keys(ks).sort()).toEqual(["disableAll", "disabledModels", "reason", "setAt", "setBy"])
      expect(ks).toMatchObject({ disableAll: false, disabledModels: [], reason: "second" })
    })

    it("every firm's next committeeBrain call is blocked kill_switch_platform, and it outranks the firm's own switch; re-enabling restores them", async () => {
      const f = await newFirm()
      const g = await newFirm()
      const a = await admin()
      const sent = fakeTransport()
      const call = (x: Firm) => send(brainAt, x.P, { firmId: x.firmId, matterId: x.matterId, body: "Draft." })
      await send(setFirmKillApi, f.P, { firmId: f.firmId, ...OK })
      await killPlatform(a, OK)
      expect(await call(f)).toMatchObject({ blocked: true, reason: "kill_switch_platform" })
      expect(await call(g)).toMatchObject({ blocked: true, reason: "kill_switch_platform" })
      expect(sent).toHaveLength(0)
      await killPlatform(a, { disableAll: false, disabledModels: [], reason: "Resolved" })
      expect(await call(g)).toMatchObject({ blocked: false })
      expect(await call(f)).toMatchObject({ blocked: true, reason: "kill_switch_firm" })
      expect(sent).toHaveLength(1)
    })

    it("is audited as ai.platform_kill_switch.set on platform/p1", async () => {
      const a = await admin()
      await killPlatform(a, OK)
      const rows = (await auditOf(a.uid, "ai.platform_kill_switch.set")).filter((r) => r.target === "platform/p1")
      expect(rows.map((r) => [r.decision, r.reason])).toEqual([["allow", "ok"]])
    })
  })

  describe("getAiUsage (P3-71)", () => {
    const usage = (f: Firm, m: Member, data: Record<string, unknown> = {}) => send(usageAt, m, { firmId: f.firmId, ...data }) as Promise<Usage>
    const monthDoc = (f: Firm, over: Record<string, unknown> = {}, key = MONTH) =>
      monthRef(f.firmId, key).set({
        firmId: f.firmId,
        monthKey: key,
        spentMicroUsd: 1_234_567,
        inputTokens: 1200,
        outputTokens: 340,
        calls: { ok: 5, failed: 1, blocked: 2 },
        updatedAt: Timestamp.now(),
        ...over,
      })

    it("only a partner: associate, clerk, intern, accounts and client are refused 403", async () => {
      const f = await newFirm()
      expectKind(await apiErrorOf(usage(f, f.A)), "permission-denied", "role_not_permitted")
      expectKind(await apiErrorOf(usage(f, f.C)), "permission-denied", "role_not_permitted")
      expectKind(await apiErrorOf(usage(f, f.intern)), "permission-denied", "role_not_permitted")
      expectKind(await apiErrorOf(usage(f, f.accounts)), "permission-denied", "accounts_register_only")
      expectKind(await apiErrorOf(usage(f, f.client)), "permission-denied", "client_denied")
      expect(await usage(f, f.outsider)).toMatchObject({ month: MONTH })
    })

    it.each(["2026-13", "2026-00", "2026-1", "26-10", "2026-10-01", "abc", "", " 2026-10"])("month %j → 400 invalid_month", async (month) => {
      const f = await newFirm()
      expectKind(await apiErrorOf(usage(f, f.P, { month })), "invalid-argument", "invalid_month")
    })

    it("the default month is the current PKT month: 19:30Z on 31 October is November", async () => {
      const f = await newFirm()
      const lateOct = viaApi<Usage>("getAiUsage", { now: () => Date.parse("2026-10-31T19:30:00.000Z") })
      const earlyOct = viaApi<Usage>("getAiUsage", { now: () => Date.parse("2026-10-31T18:59:00.000Z") })
      expect((await send(lateOct, f.P, { firmId: f.firmId }) as Usage).month).toBe("2026-11")
      expect((await send(earlyOct, f.P, { firmId: f.firmId }) as Usage).month).toBe("2026-10")
      expect((await usage(f, f.P, { month: "2025-02" })).month).toBe("2025-02")
    })

    it("a month with no calls returns zeros, with the budget and rate not set as null", async () => {
      const f = await newFirm({ budget: null })
      const u = await usage(f, f.P)
      expect(u).toEqual({
        month: MONTH,
        budgetMicroUsd: null,
        spentMicroUsd: 0,
        spentPkr: null,
        pkrPerUsd: null,
        percentUsed: null,
        calls: { ok: 0, failed: 0, blocked: 0, reconciled: 0 },
        inputTokens: 0,
        outputTokens: 0,
        alerts: [],
        killSwitch: { firm: null, platform: null },
      })
    })

    it("with a budget and a rate but no calls: spend 0, 0 PKR, 0 percent", async () => {
      const f = await newFirm({ budget: null })
      await firmConfigRef(f.firmId).set({ monthlyBudgetMicroUsd: 3_000_000, pkrPerUsd: 281.25 })
      expect(await usage(f, f.P)).toMatchObject({ budgetMicroUsd: 3_000_000, spentMicroUsd: 0, spentPkr: 0, pkrPerUsd: 281.25, percentUsed: 0 })
    })

    it("the exact response from the month total: spend, PKR to 2 decimal places, percent used to 2 decimal places, calls, tokens", async () => {
      const f = await newFirm({ budget: null })
      await firmConfigRef(f.firmId).set({ monthlyBudgetMicroUsd: 3_000_000, pkrPerUsd: 281.25 })
      await monthDoc(f)
      await monthDoc(f, { spentMicroUsd: 999_999_999 }, "2026-09")
      expect(await usage(f, f.P)).toEqual({
        month: MONTH,
        budgetMicroUsd: 3_000_000,
        spentMicroUsd: 1_234_567,
        spentPkr: 347.22,
        pkrPerUsd: 281.25,
        percentUsed: 41.15,
        calls: { ok: 5, failed: 1, blocked: 2, reconciled: 0 },
        inputTokens: 1200,
        outputTokens: 340,
        alerts: [],
        killSwitch: { firm: null, platform: null },
      })
      expect(await usage(f, f.P, { month: "2026-09" })).toMatchObject({ month: "2026-09", spentMicroUsd: 999_999_999 })
      expect(await usage(f, f.P, { month: "2026-08" })).toMatchObject({ month: "2026-08", spentMicroUsd: 0, calls: { ok: 0, failed: 0, blocked: 0 } })
    })

    it("a budget with no rate gives spentPkr and pkrPerUsd null; a rate with no budget gives percentUsed null", async () => {
      const f = await newFirm({ budget: null })
      await monthDoc(f, { spentMicroUsd: 1_050_000 })
      await firmConfigRef(f.firmId).set({ monthlyBudgetMicroUsd: 1_500_000 })
      expect(await usage(f, f.P)).toMatchObject({ budgetMicroUsd: 1_500_000, spentPkr: null, pkrPerUsd: null, percentUsed: 70 })
      await firmConfigRef(f.firmId).set({ pkrPerUsd: 280 })
      expect(await usage(f, f.P)).toMatchObject({ budgetMicroUsd: null, spentPkr: 294, pkrPerUsd: 280, percentUsed: null })
    })

    it("reports the alerts crossed with their creation time, in threshold order, for the month asked", async () => {
      const f = await newFirm()
      const t70 = Timestamp.fromMillis(Date.parse("2026-10-05T08:00:00.000Z"))
      const t90 = Timestamp.fromMillis(Date.parse("2026-10-09T12:30:00.000Z"))
      await alertRef(f.firmId, MONTH, 90).set({ firmId: f.firmId, monthKey: MONTH, threshold: 90, createdAt: t90 })
      expect((await usage(f, f.P)).alerts).toEqual([{ threshold: 90, at: "2026-10-09T12:30:00.000Z" }])
      await alertRef(f.firmId, MONTH, 70).set({ firmId: f.firmId, monthKey: MONTH, threshold: 70, createdAt: t70 })
      await alertRef(f.firmId, "2026-09", 70).set({ firmId: f.firmId, monthKey: "2026-09", threshold: 70, createdAt: t70 })
      expect((await usage(f, f.P)).alerts).toEqual([
        { threshold: 70, at: "2026-10-05T08:00:00.000Z" },
        { threshold: 90, at: "2026-10-09T12:30:00.000Z" },
      ])
      expect((await usage(f, f.P, { month: "2026-09" })).alerts).toEqual([{ threshold: 70, at: "2026-10-05T08:00:00.000Z" }])
    })

    it("shows both kill switches as views with an ISO setAt, firm and platform", async () => {
      const f = await newFirm()
      const a = await mintIdToken({ platformAdmin: true })
      await send(setFirmKillApi, f.P, { firmId: f.firmId, disableAll: false, disabledModels: [OPUS], reason: "Firm stop" })
      await send(setPlatformKillApi, a, { disableAll: true, disabledModels: [], reason: "Platform stop" })
      const u = await usage(f, f.P)
      expect(u.killSwitch.firm).toEqual({ disableAll: false, disabledModels: [OPUS], reason: "Firm stop", setBy: f.P.uid, setAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) })
      expect(u.killSwitch.platform).toEqual({ disableAll: true, disabledModels: [], reason: "Platform stop", setBy: "platform", setAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) })
    })

    it("never shows a firm the operator's identity: the platform view says setBy \"platform\", whoever set it, in any firm's response", async () => {
      const a = await newFirm()
      const b = await newFirm()
      const operator = await mintIdToken({ ...claims(a.firmId, "partner"), platformAdmin: true })
      await send(setPlatformKillApi, operator, { disableAll: true, disabledModels: [OPUS], reason: "Operator stop" })
      await send(setFirmKillApi, b.P, { firmId: b.firmId, disableAll: false, disabledModels: [], reason: "Firm B note" })
      for (const [firm, partner] of [[b, b.P], [a, a.P]] as const) {
        const u = await usage(firm, partner)
        expect(u.killSwitch.platform).toEqual({ disableAll: true, disabledModels: [OPUS], reason: "Operator stop", setBy: "platform", setAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) })
        expect(JSON.stringify(u)).not.toContain(operator.uid)
        if (firm === b) expect(JSON.stringify(u)).not.toContain(a.firmId)
      }
      // The stored switch keeps the real uid (audit trail); only the firm-facing view hides it.
      expect((await platformConfigRef().get()).get("killSwitch.setBy")).toBe(operator.uid)
      // A firm's own switch still names its partner.
      expect((await usage(b, b.P)).killSwitch.firm).toMatchObject({ setBy: b.P.uid })
    })

    it("counts what committeeBrain did, per firm: an ok call, a blocked call and a failed call", async () => {
      const f = await newFirm()
      const g = await newFirm()
      await send(setBudgetApi, f.P, { firmId: f.firmId, monthlyBudgetUsd: 1, pkrPerUsd: 280 })
      const ok = fakeTransport()
      const ask = (extra: Record<string, unknown> = {}) => send(brainAt, f.P, { firmId: f.firmId, matterId: f.matterId, body: "Draft.", ...extra })
      await ask()
      await ask({ classification: "confidential" })
      fakeTransport(async () => {
        throw new Error("boom")
      })
      await ask()
      expect(ok).toHaveLength(1)
      const u = await usage(f, f.P)
      expect(u).toMatchObject({
        month: MONTH,
        budgetMicroUsd: 1_000_000,
        spentMicroUsd: 14_000,
        spentPkr: 3.92,
        percentUsed: 1.4,
        calls: { ok: 1, failed: 1, blocked: 1 },
        inputTokens: 1000,
        outputTokens: 500,
      })
      expect(await usage(g, g.P)).toMatchObject({ budgetMicroUsd: BIG, spentMicroUsd: 0, calls: { ok: 0, failed: 0, blocked: 0 } })
    })

    it("is audited as ai.usage.read, and the response has exactly the documented keys", async () => {
      const f = await newFirm()
      const u = await usage(f, f.P)
      expect(Object.keys(u).sort()).toEqual(
        ["alerts", "budgetMicroUsd", "calls", "inputTokens", "killSwitch", "month", "outputTokens", "percentUsed", "pkrPerUsd", "spentMicroUsd", "spentPkr"].sort()
      )
      expect(Object.keys(u.killSwitch).sort()).toEqual(["firm", "platform"])
      // Codex P2 on PR #40: calls the lease reconciler settled are counted beside the others (additive).
      expect(Object.keys(u.calls).sort()).toEqual(["blocked", "failed", "ok", "reconciled"])
      const rows = (await auditOf(f.P.uid, "ai.usage.read")).filter((r) => r.target === `ai_usage_months/${f.firmId}_${MONTH}`)
      expect(rows.map((r) => [r.firmId, r.decision, r.reason])).toEqual([[f.firmId, "allow", "ok"]])
    })
  })
})
