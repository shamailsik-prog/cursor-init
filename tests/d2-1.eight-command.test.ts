import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { decide, type DecisionCaller } from "@/platform/p5/permissionDecision"
import { seedUser } from "@/platform/p5/checkPermission"
import { newStore, type Role, type SpineStore } from "@/platform/spine/store"
import { createClient } from "@/services/d1-1/clients"
import { addMember, confirmEngagement, createMatter } from "@/services/d1-2/matters"
import { escalateSilence, intimationsFor } from "@/platform/p4/intimation"
import { followUpsFor, recordCaseNumber } from "@/services/d6-1/caseNumber"
import {
  D2_WHATSAPP_GRAMMAR_FLAG,
  INCLUDED_WHATSAPP_COMMANDS,
  WA_31_CUT_COMMANDS,
  isD2WhatsAppGrammarEnabled,
  parseWhatsAppMessage,
} from "@/services/d2-1/grammar"
import {
  WHATSAPP_WEB_ACTION,
  dispatchWhatsApp,
  permitWhatsApp,
  resetD2WhatsAppThreadsForTests,
} from "@/services/d2-1/dispatch"
import { StubWhatsAppTransport } from "@/services/d2-1/transport"
import {
  handleWhatsAppWebhook,
  resetD2WhatsAppWebhookForTests,
  type WebhookDeps,
} from "@/services/d2-1/webhook"
import { POST as whatsAppPost } from "@/app/api/d2/whatsapp/route"

/**
 * Q14a / FA-D2WA-002. The eight commands are Layer 18 §8
 * (docs/architecture/SIKANDER_AI_Architecture_Set_v19.txt, "8. WhatsApp Command Grammar").
 * Each one must call the same decide() action the web already uses.
 */

const WEB_ACTION = {
  matters: "list_matters",
  hearings: "list_matters",
  clients: "client.read",
  drafts: "draft",
  research: "research",
  presence: "client.read",
  intake: "list_matters",
  help: "list_matters",
} as const

const EIGHT = ["matters", "hearings", "clients", "drafts", "research", "presence", "intake", "help"] as const

const HAPPY_TEXT: Record<(typeof EIGHT)[number], string> = {
  matters: "/matters",
  hearings: "/hearings today",
  clients: "/clients",
  drafts: "/drafts",
  research: "/research PPC 302",
  presence: "/presence in",
  intake: "/intake",
  help: "/help",
}

const DENIED_ROLE: Record<(typeof EIGHT)[number], Role> = {
  matters: "accounts",
  hearings: "accounts",
  clients: "client",
  drafts: "client",
  research: "client",
  presence: "client",
  intake: "accounts",
  help: "accounts",
}

const SECRET = "test-whatsapp-secret"
const NOW = Date.parse("2026-11-15T00:00:00Z")

function caller(role: Role): DecisionCaller {
  return { role, firmId: "firmA", clearanceLevel: "privileged" }
}

function user(store: SpineStore, id: string, role: Role) {
  return seedUser(store, { id, firmId: "firmA", role, clearanceLevel: "privileged" })
}

function sign(secret: string, raw: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
}

function signed(payload: unknown, secret = SECRET): Request {
  const raw = JSON.stringify(payload)
  return new Request("http://127.0.0.1/api/d2/whatsapp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": sign(secret, raw),
    },
    body: raw,
  })
}

function deps(store: SpineStore, transport: StubWhatsAppTransport, extra: Partial<WebhookDeps> = {}): WebhookDeps {
  return {
    store: () => store,
    transport,
    secret: () => SECRET,
    now: NOW,
    requireIdempotencyKey: (request) => {
      const key = request.headers.get("Idempotency-Key")
      if (!key) throw new Error("Idempotency-Key header required")
      return key
    },
    ...extra,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  resetD2WhatsAppThreadsForTests()
  resetD2WhatsAppWebhookForTests()
})

describe("D2-1 eight-command grammar (Layer 18 §8)", () => {
  it("lists exactly the eight included commands", () => {
    expect(INCLUDED_WHATSAPP_COMMANDS.map((row) => row.name)).toEqual([...EIGHT])
  })

  it.each([
    ["/matters", "matters"],
    ["/MATTERS", "matters"],
    ["میرے کیس", "matters"],
    ["میرےکیس", "matters"],
    ["مقدمات", "matters"],
    ["کیس", "matters"],
    ["/hearings tomorrow", "hearings"],
    ["سماعت", "hearings"],
    ["پیشی", "hearings"],
    ["/clients Ali", "clients"],
    ["کلائنٹ", "clients"],
    ["موکل", "clients"],
    ["/drafts", "drafts"],
    ["مسودہ", "drafts"],
    ["ڈرافٹ", "drafts"],
    ["/research PPC 302", "research"],
    ["تحقیق PPC 302", "research"],
    ["ریسرچ PPC 302", "research"],
    ["/presence out", "presence"],
    ["حاضری", "presence"],
    ["/intake", "intake"],
    ["نیا کیس", "intake"],
    ["نیاکیس", "intake"],
    ["/help", "help"],
    ["مدد", "help"],
  ])("%j parses as %s", (text, name) => {
    const parsed = parseWhatsAppMessage(text)
    expect(parsed.kind).toBe("command")
    if (parsed.kind === "command") expect(parsed.name).toBe(name)
  })

  it.each(["open 2", "kholo 2", "کھولیں 2", "/open 2"])("%j is the numbered reply, not a ninth command", (text) => {
    const parsed = parseWhatsAppMessage(text)
    expect(parsed.kind).toBe("reply")
    if (parsed.kind === "reply") expect(parsed.n).toBe(2)
  })

  it.each([
    "/today",
    "/conflict",
    "/statutes",
    "/limitation",
    "/bail",
    "/citations",
    "/deadline",
    "/report",
    "/profile",
    "DRAFT",
    "STATUS",
    "FIND",
    "UPLOAD",
    "REMIND",
    "OPINION",
    "JOB",
    "/note",
    "/NOTE extra",
  ])("cut command %j is refused as WA_31_CUT", (text) => {
    const parsed = parseWhatsAppMessage(text)
    expect(parsed.kind).toBe("cut")
  })

  it("does not invent cut names that the architecture text does not list", () => {
    expect([...WA_31_CUT_COMMANDS].sort()).toEqual(
      [
        "bail",
        "citations",
        "conflict",
        "deadline",
        "draft",
        "find",
        "job",
        "limitation",
        "note",
        "opinion",
        "profile",
        "remind",
        "report",
        "statutes",
        "status",
        "today",
        "upload",
      ].sort()
    )
  })

  it.each(["/ops", "/ops queue", "/foo", "hello"])("%j is outside the eight and is not a cut command", (text) => {
    expect(parseWhatsAppMessage(text).kind).toBe("unsupported")
  })

  it.each(["/research", "/hearings not-a-date", "/presence sideways", "/help extra"])(
    "%j is malformed rather than executed",
    (text) => {
      expect(parseWhatsAppMessage(text).kind).toBe("malformed")
    }
  )
})

describe("dispatcher: eight commands through decide()", () => {
  it("maps every included command to the web decide() action", () => {
    expect(WHATSAPP_WEB_ACTION).toEqual(WEB_ACTION)
  })

  it.each(EIGHT)("%s happy path is allowed by the same decide() result", async (name) => {
    const store = newStore()
    user(store, "staff", name === "drafts" ? "associate" : "clerk")
    user(store, "client1", "client")
    const actor = name === "intake" ? "client1" : "staff"
    const role: Role = actor === "client1" ? "client" : name === "drafts" ? "associate" : "clerk"
    if (name === "clients") {
      const entity = createClient(store, {
        firmId: "firmA",
        canonicalName: "Alpha Client",
        cnic: "4210112345671",
        phone: "03001111111",
        classification: "internal",
      })
      const matter = createMatter(store, {
        firmId: "firmA",
        clientId: entity.id,
        title: "Alpha matter",
        courtId: "SHC",
        classification: "internal",
      })
      addMember(store, matter.id, "staff", "firmA")
      createClient(store, {
        firmId: "firmB",
        canonicalName: "Foreign Client",
        cnic: "3520222222222",
        phone: "03002222222",
        classification: "internal",
      })
    }
    if (name === "drafts") {
      const matter = createMatter(store, {
        firmId: "firmA",
        clientId: "client1",
        title: "Draft matter",
        courtId: "SHC",
        classification: "internal",
      })
      addMember(store, matter.id, "staff", "firmA")
      matter.caseNumber = "CP D-1/2026"
      store.drafts.set("dr1", {
        id: "dr1",
        firmId: "firmA",
        matterId: matter.id,
        templateId: "t",
        title: "Plea",
        body: "Body",
        classification: "internal",
        createdBy: "staff",
        createdAt: 1,
        status: "draft",
      })
    }
    const reads: string[] = []
    const result = await dispatchWhatsApp(store, actor, HAPPY_TEXT[name], {
      now: NOW,
      readResearch: async (query) => {
        reads.push(query)
        return [{ title: `Hit ${query}` }]
      },
    })
    expect(result.ok).toBe(true)
    expect(result.denied).toBeFalsy()
    expect(result.permission).toEqual(decide(caller(role), WEB_ACTION[name], undefined, false))
    if (name === "research") expect(reads).toEqual(["PPC 302"])
    if (name === "clients") {
      expect(result.clients?.map((row) => row.name)).toEqual(["Alpha Client"])
    }
    if (name === "drafts") expect(result.drafts?.map((row) => row.title)).toEqual(["Plea"])
    if (name === "hearings") expect(result.hearings?.date).toBe("2026-11-15")
    if (name === "presence") expect(result.presence).toEqual({ direction: "in", recorded: false })
    if (name === "intake") {
      expect(result.intake).toEqual({ accepted: true, persisted: false })
      expect(store.entities.size).toBe(0)
    }
    if (name === "help") expect(result.help?.commands).toHaveLength(8)
  })

  it.each(EIGHT)("%s permission-denied path matches decide() and returns no data", async (name) => {
    const store = newStore()
    const role = DENIED_ROLE[name]
    user(store, "actor", role)
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "actor",
      title: "Secret matter",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "actor", "firmA")
    const reads: string[] = []
    const result = await dispatchWhatsApp(store, "actor", HAPPY_TEXT[name], {
      now: NOW,
      readResearch: async (query) => {
        reads.push(query)
        return [{ title: "should not be read" }]
      },
    })
    expect(result.ok).toBe(false)
    expect(result.denied).toBe(true)
    expect(result.permission).toEqual(decide(caller(role), WEB_ACTION[name], undefined, false))
    expect(result.permission?.allow).toBe(false)
    expect(result.matters).toBeUndefined()
    expect(result.clients).toBeUndefined()
    expect(result.drafts).toBeUndefined()
    expect(result.research).toBeUndefined()
    expect(result.hearings).toBeUndefined()
    expect(result.text).toBe("permission denied")
    expect(result.text).not.toContain("Secret matter")
    expect(reads).toEqual([])
  })

  it("an action decide() does not know is denied unknown-action", () => {
    const store = newStore()
    user(store, "staff", "partner")
    expect(permitWhatsApp(store, "staff", "not-a-real-action")).toEqual({
      allow: false,
      reason: "unknown-action",
    })
    expect(decide(caller("partner"), "not-a-real-action", undefined, false)).toEqual({
      allow: false,
      reason: "unknown-action",
    })
  })

  it("open, kholo and کھولیں select the numbered research row after permission", async () => {
    const store = newStore()
    user(store, "staff", "associate")
    user(store, "client1", "client")
    const first = await dispatchWhatsApp(store, "staff", "/research bail", {
      readResearch: async () => [{ title: "First authority" }, { title: "Second authority" }],
    })
    expect(first.research?.map((row) => row.title)).toEqual(["First authority", "Second authority"])
    const opened = await dispatchWhatsApp(store, "staff", "kholo 2", {
      readResearch: async () => {
        throw new Error("open must not search again")
      },
    })
    expect(opened.ok).toBe(true)
    expect(opened.opened?.title).toBe("Second authority")
    const urdu = await dispatchWhatsApp(store, "staff", "کھولیں 1")
    expect(urdu.opened?.title).toBe("First authority")
    const denied = await dispatchWhatsApp(store, "client1", "open 1")
    expect(denied.denied).toBe(true)
    expect(denied.opened).toBeUndefined()
  })

  it("a cut command is refused before decide() allow and before the research reader", async () => {
    const store = newStore()
    user(store, "staff", "partner")
    const reads: string[] = []
    const result = await dispatchWhatsApp(store, "staff", "/limitation", {
      readResearch: async (query) => {
        reads.push(query)
        return []
      },
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("wa_31_cut")
    expect(result.permission).toBeUndefined()
    expect(reads).toEqual([])
  })
})

describe("forensic tests 2, 6 and 9", () => {
  it("forensic test 2: clerk /matters returns two memberships; client sees only own; client /research is denied", async () => {
    const store = newStore()
    user(store, "clerk1", "clerk")
    user(store, "client1", "client")
    const m1 = createMatter(store, {
      firmId: "firmA",
      clientId: "client1",
      title: "Matter one",
      courtId: "SHC",
      classification: "internal",
    })
    const m2 = createMatter(store, {
      firmId: "firmA",
      clientId: "other-client",
      title: "Matter two",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, m1.id, "clerk1", "firmA")
    addMember(store, m2.id, "clerk1", "firmA")
    addMember(store, m1.id, "client1", "firmA")
    const reads: string[] = []
    const clerkMatters = await dispatchWhatsApp(store, "clerk1", "/matters", { readResearch: async () => [] })
    expect(clerkMatters.denied).toBeFalsy()
    expect(clerkMatters.matters).toHaveLength(2)
    const clientMatters = await dispatchWhatsApp(store, "client1", "/matters")
    expect(clientMatters.matters).toHaveLength(1)
    expect(clientMatters.matters?.[0]?.id).toBe(m1.id)
    const research = await dispatchWhatsApp(store, "client1", "/research PPC 302", {
      readResearch: async (query) => {
        reads.push(query)
        return [{ title: "should not be read" }]
      },
    })
    expect(research.denied).toBe(true)
    expect(research.ok).toBe(false)
    expect(reads).toEqual([])
  })

  it("forensic test 6: no intimation before engagement; confirmation notifies accounts; 24h silence escalates", () => {
    const store = newStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "New brief",
      courtId: "SHC",
      classification: "internal",
    })
    expect(intimationsFor(store, matter.id)).toHaveLength(0)
    const t0 = Date.parse("2026-09-01T00:00:00Z")
    confirmEngagement(store, matter.id, t0)
    expect(intimationsFor(store, matter.id)).toHaveLength(1)
    escalateSilence(store, matter.id, t0 + 23 * 60 * 60 * 1000)
    expect(store.followUps.filter((row) => row.kind === "l4_10_silence")).toHaveLength(0)
    escalateSilence(store, matter.id, t0 + 24 * 60 * 60 * 1000)
    expect(store.followUps.filter((row) => row.kind === "l4_10_silence")).toHaveLength(1)
  })

  it("forensic test 9: SHC 'C.P. No. D-1234 of 2025' records CP D-1234/2025; 'CP 1234' is rejected and a follow-up opens", () => {
    const store = newStore()
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "SHC petition",
      courtId: "SHC",
      classification: "internal",
    })
    const ok = recordCaseNumber(store, matter.id, "C.P. No. D-1234 of 2025", "SHC")
    expect(ok.status).toBe("OK")
    expect(ok.canonical).toBe("CP D-1234/2025")
    expect(store.matters.get(matter.id)?.caseNumber).toBe("CP D-1234/2025")
    const matter2 = createMatter(store, {
      firmId: "firmA",
      clientId: "c1",
      title: "Bad number",
      courtId: "SHC",
      classification: "internal",
    })
    const bad = recordCaseNumber(store, matter2.id, "CP 1234", "SHC")
    expect(bad.status).toBe("REJECT")
    expect(followUpsFor(store, matter2.id).some((row) => row.kind === "case_number_reject")).toBe(true)
  })
})

describe("signed webhook, dedupe, stub transport, flag default off", () => {
  it("the grammar flag defaults off", () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "")
    expect(isD2WhatsAppGrammarEnabled()).toBe(false)
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    expect(isD2WhatsAppGrammarEnabled()).toBe(true)
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, " TRUE ")
    expect(isD2WhatsAppGrammarEnabled()).toBe(true)
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "yes")
    expect(isD2WhatsAppGrammarEnabled()).toBe(false)
  })

  it("flag off refuses before the secret, the store, the signature and the dispatcher", async () => {
    const transport = new StubWhatsAppTransport()
    let secretReads = 0
    let storeReads = 0
    let executed = 0
    const response = await handleWhatsAppWebhook(
      signed({ messageId: "m1", userId: "clerk1", text: "/matters" }),
      {
        transport,
        secret: () => {
          secretReads += 1
          return SECRET
        },
        store: () => {
          storeReads += 1
          return newStore()
        },
        execute: async () => {
          executed += 1
          throw new Error("must not execute")
        },
      }
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: "whatsapp_channel_disabled",
      flag: D2_WHATSAPP_GRAMMAR_FLAG,
    })
    expect(secretReads).toBe(0)
    expect(storeReads).toBe(0)
    expect(executed).toBe(0)
    expect(transport.sent).toEqual([])
  })

  it("the route refuses while the flag is off", async () => {
    const response = await whatsAppPost(
      signed({ messageId: "route-1", userId: "clerk1", text: "/help" })
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: "whatsapp_channel_disabled",
      flag: D2_WHATSAPP_GRAMMAR_FLAG,
    })
  })

  it("a bad signature is refused and nothing is dispatched", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const store = newStore()
    user(store, "clerk1", "clerk")
    const transport = new StubWhatsAppTransport()
    let executed = 0
    const request = signed({ messageId: "m-bad", userId: "clerk1", text: "/help" })
    request.headers.set("X-Hub-Signature-256", sign("other-secret", "{}"))
    const response = await handleWhatsAppWebhook(request, {
      ...deps(store, transport),
      execute: async () => {
        executed += 1
        throw new Error("must not execute")
      },
    })
    expect(response.status).toBe(401)
    expect(executed).toBe(0)
    expect(transport.sent).toEqual([])
  })

  it("flag on with no secret refuses before dispatch", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const transport = new StubWhatsAppTransport()
    let executed = 0
    const response = await handleWhatsAppWebhook(signed({ messageId: "m-sec", userId: "clerk1", text: "/help" }), {
      transport,
      secret: () => undefined,
      store: () => newStore(),
      execute: async () => {
        executed += 1
        throw new Error("must not execute")
      },
    })
    expect(response.status).toBe(401)
    expect(executed).toBe(0)
    expect(transport.sent).toEqual([])
  })

  it("a valid signed command dispatches once, the stub records the reply, and a replay does not dispatch again", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const store = newStore()
    user(store, "clerk1", "clerk")
    const transport = new StubWhatsAppTransport()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is forbidden"))
    let executed = 0
    const payload = { messageId: "wamid.1", userId: "clerk1", text: "/help" }
    const first = await handleWhatsAppWebhook(signed(payload), {
      ...deps(store, transport),
      execute: async (current, userId, text) => {
        executed += 1
        return dispatchWhatsApp(current, userId, text, { now: NOW })
      },
    })
    expect(first.status).toBe(200)
    const body = (await first.json()) as { ok: boolean; transport: string }
    expect(body.ok).toBe(true)
    expect(body.transport).toBe("stub")
    expect(executed).toBe(1)
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.delivered).toBe(false)
    const replay = await handleWhatsAppWebhook(
      signed({ messageId: "wamid.1", userId: "clerk1", text: "/matters" }),
      {
        ...deps(store, transport),
        execute: async () => {
          executed += 1
          throw new Error("replay must not execute")
        },
      }
    )
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(body)
    expect(executed).toBe(1)
    expect(transport.sent).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
