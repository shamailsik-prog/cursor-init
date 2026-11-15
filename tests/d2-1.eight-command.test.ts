import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
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
import { StubWhatsAppTransport, webhookStub } from "@/services/d2-1/transport"
import {
  handleWhatsAppWebhook,
  resetD2WhatsAppWebhookForTests,
  WHATSAPP_BODY_CAP_BYTES,
  type WebhookDeps,
} from "@/services/d2-1/webhook"
import { POST as whatsAppPost } from "@/app/api/d2/whatsapp/route"
import { setRequestAuditSinkForTests } from "@/platform/persistence/requestAuditFlush"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"

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
  return signBytes(secret, Buffer.from(raw))
}

function signBytes(secret: string, raw: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
}

function streamedRequest(
  total: number,
  chunk: number,
  headers: Record<string, string>,
  source?: Buffer
): { request: Request; pulled: () => number } {
  const bytes = source ?? Buffer.alloc(total)
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= total) {
        controller.close()
        return
      }
      const n = Math.min(chunk, total - pulled)
      controller.enqueue(bytes.subarray(pulled, pulled + n))
      pulled += n
    },
  })
  const request = new Request("http://127.0.0.1/api/d2/whatsapp", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" })
  return { request, pulled: () => pulled }
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

function settleWithin(pending: Promise<Response>, ms: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hung")), ms)
    pending.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
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
    persistAudit: async () => {},
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
    if (name === "hearings") {
      expect(result.text).toBe("hearings not available yet")
      expect(result.hearings).toBeUndefined()
      expect(JSON.stringify(result)).not.toContain('"items":[]')
    }
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

  it("a draft above the caller's clearance is omitted, including its title", async () => {
    const store = newStore()
    seedUser(store, { id: "staff", firmId: "firmA", role: "associate", clearanceLevel: "internal" })
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client1",
      title: "Visible matter",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "staff", "firmA")
    store.drafts.set("dr-hidden", {
      id: "dr-hidden",
      firmId: "firmA",
      matterId: matter.id,
      templateId: "t",
      title: "Hidden plea",
      body: "Body",
      classification: "privileged-restricted",
      createdBy: "staff",
      createdAt: 1,
      status: "draft",
    })
    const result = await dispatchWhatsApp(store, "staff", "/drafts")
    expect(result.ok).toBe(true)
    expect(result.drafts).toEqual([])
    expect(result.text).not.toContain("Hidden plea")
  })

  it("open rechecks the draft after membership is removed", async () => {
    const store = newStore()
    user(store, "staff", "associate")
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "client1",
      title: "Draft matter",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "staff", "firmA")
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
    const listed = await dispatchWhatsApp(store, "staff", "/drafts")
    expect(listed.drafts?.map((row) => row.title)).toEqual(["Plea"])
    store.members.delete(store.memberKey(matter.id, "staff"))
    const opened = await dispatchWhatsApp(store, "staff", "open 1")
    expect(opened.ok).toBe(false)
    expect(opened.denied).toBe(true)
    expect(opened.opened).toBeUndefined()
    expect(opened.text).toBe("permission denied")
    expect(opened.text).not.toContain("Plea")
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

  it("FA-Q14A-AUTH-001 ignores a body userId and returns no command output", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const store = newStore()
    user(store, "partnerB", "partner")
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "partnerB",
      title: "FIRM-B-SECRET-TITLE",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "partnerB", "firmA")
    const transport = new StubWhatsAppTransport()
    let executed = 0
    const response = await handleWhatsAppWebhook(
      signed({ messageId: "wamid.auth", userId: "partnerB", text: "/matters" }),
      {
        ...deps(store, transport),
        execute: async () => {
          executed += 1
          return dispatchWhatsApp(store, "partnerB", "/matters")
        },
      }
    )
    const body = await response.json()
    expect(executed).toBe(0)
    expect(body).toEqual({ ok: false })
    expect(JSON.stringify(body)).not.toContain("FIRM-B-SECRET-TITLE")
    expect(transport.sent.map((row) => row.text).join("\n")).not.toContain("FIRM-B-SECRET-TITLE")
  })

  it("FA-Q14A-DEDUPE-002 frees the slot when the store throws", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const transport = new StubWhatsAppTransport()
    let reads = 0
    const payload = { messageId: "wamid.store", userId: "clerk1", text: "/help" }
    const call = () =>
      handleWhatsAppWebhook(signed(payload), {
        ...deps(newStore(), transport),
        store: () => {
          reads += 1
          if (reads === 1) throw new Error("store down")
          return newStore()
        },
      })
    const first = await settleWithin(call(), 500)
    const second = await settleWithin(call(), 500)
    expect(first.status).toBe(503)
    expect(await first.json()).toEqual({ ok: false })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: false })
    expect(reads).toBeGreaterThan(1)
  })

  it("FA-Q14A-DEDUPE-002 frees the slot when the transport throws", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const store = newStore()
    user(store, "clerk1", "clerk")
    let sends = 0
    const transport = new StubWhatsAppTransport()
    const original = transport.send.bind(transport)
    transport.send = async (message) => {
      sends += 1
      if (sends === 1) throw new Error("send down")
      return original(message)
    }
    const payload = { messageId: "wamid.send", userId: "clerk1", text: "/help" }
    const first = await settleWithin(handleWhatsAppWebhook(signed(payload), deps(store, transport)), 500)
    const second = await settleWithin(handleWhatsAppWebhook(signed(payload), deps(store, transport)), 500)
    expect(first.status).toBe(503)
    expect(await first.json()).toEqual({ ok: false })
    expect(second.status).toBe(200)
    expect(sends).toBeGreaterThan(1)
  })

  it("FA-Q14A-DEDUPE-002 bounds a stalled dispatch and frees the slot", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const realSetTimeout = globalThis.setTimeout
    vi.useFakeTimers()
    try {
      const store = newStore()
      user(store, "clerk1", "clerk")
      const transport = new StubWhatsAppTransport()
      const original = transport.send.bind(transport)
      let hang = true
      transport.send = (message) => (hang ? new Promise(() => {}) : original(message))
      const payload = { messageId: "wamid.stall", userId: "clerk1", text: "/matters" }
      const pending = handleWhatsAppWebhook(signed(payload), deps(store, transport))
      const duplicate = handleWhatsAppWebhook(signed(payload), deps(store, transport))
      await vi.advanceTimersByTimeAsync(5_000)
      const outcome = await new Promise<string>((resolve) => {
        realSetTimeout(() => {
          let settled = 0
          const mark = () => {
            settled += 1
          }
          pending.then(mark, mark)
          duplicate.then(mark, mark)
          realSetTimeout(() => resolve(settled === 2 ? "settled" : "hung"), 30)
        }, 20)
      })
      expect(outcome).toBe("settled")
      hang = false
      const retry = await handleWhatsAppWebhook(signed(payload), deps(store, transport))
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual({ ok: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it("FA-Q14A-SIG-005 rejects an oversized body before the signature and a whitespace secret", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const transport = new StubWhatsAppTransport()
    const huge = "x".repeat(9000)
    const raw = JSON.stringify({ messageId: "wamid.huge", userId: "clerk1", text: huge })
    const oversized = new Request("http://127.0.0.1/api/d2/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(raw)),
        "X-Hub-Signature-256": sign(SECRET, raw),
      },
      body: raw,
    })
    const tooBig = await handleWhatsAppWebhook(oversized, deps(newStore(), transport))
    expect(tooBig.status).toBe(413)
    expect(transport.sent).toEqual([])
    const padded = "   "
    const blank = await handleWhatsAppWebhook(
      signed({ messageId: "wamid.ws", userId: "clerk1", text: "/help" }, padded),
      {
        ...deps(newStore(), transport),
        secret: () => padded,
      }
    )
    expect(blank.status).toBe(401)
    expect(transport.sent).toEqual([])
  })

  it("FA-Q14A-DEDUPE-004 keys a replay on the payload and expires it", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const store = newStore()
    const transport = new StubWhatsAppTransport()
    const payload = { messageId: "wamid.ttl", userId: "clerk1", text: "/help" }
    const first = await handleWhatsAppWebhook(signed(payload), { ...deps(store, transport), now: NOW })
    expect(await first.json()).toEqual({ ok: false })
    const other = await handleWhatsAppWebhook(
      signed({ messageId: "wamid.ttl", userId: "partnerB", text: "/matters" }),
      { ...deps(store, transport), now: NOW }
    )
    expect(transport.sent).toHaveLength(2)
    expect(await other.json()).toEqual({ ok: false })
    const replay = await handleWhatsAppWebhook(signed(payload), { ...deps(store, transport), now: NOW })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ ok: false })
    expect(transport.sent).toHaveLength(2)
    const later = await handleWhatsAppWebhook(signed(payload), {
      ...deps(store, transport),
      now: NOW + 24 * 60 * 60 * 1000,
    })
    expect(later.status).toBe(200)
    expect(transport.sent.length).toBeGreaterThan(2)
  })

  it("a signed command does not dispatch, the stub records not linked, and the same bytes replay once", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const store = newStore()
    user(store, "clerk1", "clerk")
    const transport = new StubWhatsAppTransport()
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network is forbidden"))
    let executed = 0
    const payload = { messageId: "wamid.1", userId: "clerk1", text: "/help" }
    const first = await handleWhatsAppWebhook(signed(payload), {
      ...deps(store, transport),
      execute: async () => {
        executed += 1
        throw new Error("body identity must not dispatch")
      },
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: false })
    expect(executed).toBe(0)
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.text).toBe("not linked")
    expect(transport.sent[0]?.delivered).toBe(false)
    const replay = await handleWhatsAppWebhook(signed(payload), deps(store, transport))
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ ok: false })
    expect(transport.sent).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it("does not persist a permission audit or return command output when no phone is linked", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const store = newStore()
    user(store, "clerk1", "clerk")
    const transport = new StubWhatsAppTransport()
    let audited = 0
    const response = await handleWhatsAppWebhook(signed({ messageId: "wamid.audit", userId: "clerk1", text: "/help" }), {
      ...deps(store, transport),
      persistAudit: async () => {
        audited += 1
        throw new Error("audit store down")
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false })
    expect(audited).toBe(0)
    expect(transport.sent.map((row) => row.text)).toEqual(["not linked"])
  })

  it("overlapping deliveries of the same bytes send the unbound reply once", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const store = newStore()
    const transport = new StubWhatsAppTransport()
    let executed = 0
    const payload = { messageId: "wamid.race", userId: "clerk1", text: "/help" }
    const call = () =>
      handleWhatsAppWebhook(signed(payload), {
        ...deps(store, transport),
        execute: async () => {
          executed += 1
          throw new Error("body identity must not dispatch")
        },
      })
    const [left, right] = await Promise.all([call(), call()])
    const leftBody = await left.json()
    const rightBody = await right.json()
    expect(left.status).toBe(200)
    expect(right.status).toBe(200)
    expect(rightBody).toEqual(leftBody)
    expect(leftBody).toEqual({ ok: false })
    expect(executed).toBe(0)
    expect(transport.sent).toHaveLength(1)
  })

  it("the route returns only ok and does not leak a permission decision", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    vi.stubEnv("WHATSAPP_APP_SECRET", SECRET)
    resetRuntimeStoreForTests()
    const store = getRuntimeStore()
    user(store, "clerk1", "clerk")
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: "clerk1",
      title: "ROUTE-SECRET-TITLE",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "clerk1", "firmA")
    const seen: string[] = []
    setRequestAuditSinkForTests(async (rows) => {
      seen.push(...rows.map((row) => row.action))
    })
    try {
      const response = await whatsAppPost(signed({ messageId: "wamid.route", userId: "clerk1", text: "/matters" }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: false })
      expect(seen).not.toContain("permission_check")
      expect(JSON.stringify(webhookStub.sent)).not.toContain("ROUTE-SECRET-TITLE")
      expect(webhookStub.sent.map((row) => row.text)).toEqual(["not linked"])
    } finally {
      setRequestAuditSinkForTests(null)
      resetRuntimeStoreForTests()
      resetD2WhatsAppWebhookForTests()
    }
  })

  it("FA-Q14A-SIG-005 stops reading a stream that has no Content-Length once the cap is crossed", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const total = 64 * 1024
    const chunk = 1024
    const raw = Buffer.alloc(total)
    const { request, pulled } = streamedRequest(total, chunk, {
      "Content-Type": "application/octet-stream",
      "X-Hub-Signature-256": signBytes(SECRET, raw),
    })
    expect(request.headers.get("content-length")).toBeNull()
    const transport = new StubWhatsAppTransport()
    const response = await handleWhatsAppWebhook(request, deps(newStore(), transport))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "payload_too_large" })
    expect(pulled()).toBeGreaterThan(WHATSAPP_BODY_CAP_BYTES)
    expect(pulled()).toBeLessThanOrEqual(WHATSAPP_BODY_CAP_BYTES + chunk)
    expect(transport.sent).toEqual([])
  })

  it("FA-Q14A-SIG-005 rejects Content-Length over the cap before any body byte is read", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const raw = Buffer.from(JSON.stringify({ messageId: "wamid.cl", text: "/help" }))
    const { request } = streamedRequest(raw.byteLength, raw.byteLength, {
      "Content-Type": "application/json",
      "Content-Length": String(WHATSAPP_BODY_CAP_BYTES + 1),
      "X-Hub-Signature-256": signBytes(SECRET, raw),
    }, raw)
    const transport = new StubWhatsAppTransport()
    const response = await handleWhatsAppWebhook(request, deps(newStore(), transport))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "payload_too_large" })
    expect(transport.sent).toEqual([])
  })

  it("FA-Q14A-SIG-005 rejects a body over the cap when Content-Length understates it", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const total = WHATSAPP_BODY_CAP_BYTES + 2048
    const chunk = 1024
    const raw = Buffer.alloc(total)
    const { request, pulled } = streamedRequest(total, chunk, {
      "Content-Type": "application/octet-stream",
      "Content-Length": "1",
      "X-Hub-Signature-256": signBytes(SECRET, raw),
    })
    const transport = new StubWhatsAppTransport()
    const response = await handleWhatsAppWebhook(request, deps(newStore(), transport))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "payload_too_large" })
    expect(pulled()).toBeLessThanOrEqual(WHATSAPP_BODY_CAP_BYTES + chunk)
    expect(transport.sent).toEqual([])
  })

  it("FA-Q14A-SIG-005 accepts a body that is exactly the cap", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const raw = Buffer.alloc(WHATSAPP_BODY_CAP_BYTES)
    const { request, pulled } = streamedRequest(raw.byteLength, 1024, {
      "Content-Type": "application/octet-stream",
      "X-Hub-Signature-256": signBytes(SECRET, raw),
    })
    const transport = new StubWhatsAppTransport()
    const response = await handleWhatsAppWebhook(request, deps(newStore(), transport))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false })
    expect(pulled()).toBe(WHATSAPP_BODY_CAP_BYTES)
    expect(transport.sent).toHaveLength(1)
  })

  it("FA-Q14A-SIG-005 returns 413 for an oversized body before it inspects the signature", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const total = WHATSAPP_BODY_CAP_BYTES + 1024
    const { request } = streamedRequest(total, 1024, {
      "Content-Type": "application/octet-stream",
      "X-Hub-Signature-256": "sha256=" + "ab".repeat(32),
    })
    expect(request.headers.get("content-length")).toBeNull()
    const transport = new StubWhatsAppTransport()
    const response = await handleWhatsAppWebhook(request, deps(newStore(), transport))
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: "payload_too_large" })
    expect(transport.sent).toEqual([])
  })

  it("FA-Q14A-SIG-005 verifies the HMAC over the raw bytes, not the decoded text", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const raw = Buffer.from([0x7b, 0xff, 0x7d])
    const request = new Request("http://127.0.0.1/api/d2/whatsapp", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Hub-Signature-256": signBytes(SECRET, raw),
      },
      body: raw,
    })
    const transport = new StubWhatsAppTransport()
    const response = await handleWhatsAppWebhook(request, deps(newStore(), transport))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: false })
    expect(transport.sent).toHaveLength(1)
  })

  it("FA-Q14A-SIG-005 refuses an empty secret even when the body is signed with it", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const transport = new StubWhatsAppTransport()
    const response = await handleWhatsAppWebhook(signed({ messageId: "wamid.empty", text: "/help" }, ""), {
      ...deps(newStore(), transport),
      secret: () => "",
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "webhook_not_configured" })
    expect(transport.sent).toEqual([])
  })

  it("FA-Q14A-R2-L1 cancels a timed-out send so the late completion and the retry produce one message", async () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "true")
    const realSetTimeout = globalThis.setTimeout
    vi.useFakeTimers()
    try {
      const transport = new StubWhatsAppTransport()
      const original = transport.send.bind(transport)
      let release: () => void = () => {}
      const hold = new Promise<void>((resolve) => {
        release = resolve
      })
      let calls = 0
      transport.send = async (message, options) => {
        calls += 1
        if (calls === 1) await hold
        return original(message, options)
      }
      const payload = { messageId: "wamid.late", userId: "clerk1", text: "/help" }
      const pending = handleWhatsAppWebhook(signed(payload), deps(newStore(), transport))
      await vi.advanceTimersByTimeAsync(5_000)
      const first = await pending
      expect(first.status).toBe(503)
      release()
      await new Promise((resolve) => realSetTimeout(resolve, 0))
      const retry = await handleWhatsAppWebhook(signed(payload), deps(newStore(), transport))
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual({ ok: false })
      expect(transport.sent).toHaveLength(1)
      expect(transport.sent[0]?.text).toBe("not linked")
    } finally {
      vi.useRealTimers()
    }
  })

  it("an aborted send records nothing and does not consume its idempotency key", async () => {
    const transport = new StubWhatsAppTransport()
    const message = { toUserId: "unbound", text: "not linked" }
    const controller = new AbortController()
    controller.abort()
    await expect(transport.send(message, { signal: controller.signal, idempotencyKey: "same" })).rejects.toThrow()
    await transport.send(message, { idempotencyKey: "same" })
    expect(transport.sent).toHaveLength(1)
  })

  it("two sends with the same idempotency key record one outbound message", async () => {
    const transport = new StubWhatsAppTransport()
    const message = { toUserId: "unbound", text: "not linked" }
    await transport.send(message, { idempotencyKey: "same" })
    await transport.send(message, { idempotencyKey: "same" })
    await transport.send({ toUserId: "unbound", text: "other" }, { idempotencyKey: "other" })
    expect(transport.sent.map((row) => row.text)).toEqual(["not linked", "other"])
  })

  it("FA-Q14A-PARITY-006 denies an intern the client registry the web route denies", async () => {
    const store = newStore()
    user(store, "intern1", "intern")
    const entity = createClient(store, {
      firmId: "firmA",
      canonicalName: "Intern Visible Client",
      cnic: "4210112345671",
      phone: "03001111111",
      classification: "internal",
    })
    const matter = createMatter(store, {
      firmId: "firmA",
      clientId: entity.id,
      title: "Intern matter",
      courtId: "SHC",
      classification: "internal",
    })
    addMember(store, matter.id, "intern1", "firmA")
    expect(decide(caller("intern"), "client.read", undefined, false).allow).toBe(true)
    const result = await dispatchWhatsApp(store, "intern1", "/clients")
    expect(result.ok).toBe(false)
    expect(result.denied).toBe(true)
    expect(result.clients).toBeUndefined()
    expect(result.permission).toEqual({
      allow: false,
      reason: "user role not allowed for client registry reads",
    })
    expect(result.text).not.toContain("Intern Visible Client")
    expect(store.audit.some((row) => row.action === "permission_check" && row.reason?.startsWith("allow:"))).toBe(false)
  })

  it("an intern still follows decide() for presence", async () => {
    const store = newStore()
    user(store, "intern1", "intern")
    const result = await dispatchWhatsApp(store, "intern1", "/presence in")
    expect(result.ok).toBe(true)
    expect(result.permission).toEqual(decide(caller("intern"), "client.read", undefined, false))
  })

  it("FA-Q14A-FLAG-008 does not let a firm-scoped value turn the channel on", () => {
    vi.stubEnv(`SIKANDER_FLAG_${D2_WHATSAPP_GRAMMAR_FLAG}`, "")
    vi.stubEnv("SIKANDER_FLAG_D2_WHATSAPP_GRAMMAR_FIRM", "true")
    expect(isD2WhatsAppGrammarEnabled()).toBe(false)
    expect(isD2WhatsAppGrammarEnabled.length).toBe(0)
    const src = readFileSync(new URL("../services/d2-1/grammar.ts", import.meta.url), "utf8")
    const start = src.indexOf("export function isD2WhatsAppGrammarEnabled")
    const end = src.indexOf("export const INCLUDED_WHATSAPP_COMMANDS")
    const body = src.slice(start, end)
    expect(body).toContain("SIKANDER_FLAG_")
    expect(body).not.toMatch(/firmId|FLAG_REGISTRY|perFirm/)
  })
})
