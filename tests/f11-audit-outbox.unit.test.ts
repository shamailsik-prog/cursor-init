// Audit F11, without an emulator: the outbox contract shared by Next and the Functions reconciler, the memory
// dead-letter listing (F12 re-audit LOW-2), the production guard on the request-audit sink seam, and the refusal of a
// client-SDK write inside a request (it has no transaction to stage the outbox in).
// The F11 modules are loaded loosely so each test fails on its own assertion against main.
// Spec: docs/superpowers/specs/2026-10-18-f11-atomic-request-audit-design.md.
import { randomUUID } from "node:crypto"
import { deleteApp, initializeApp } from "firebase/app"
import { getFirestore, terminate } from "firebase/firestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import { UNFENCED_COLLECTIONS } from "@/platform/http/durableIdempotency"
import { withSession } from "@/platform/http/withSession"
import { doc, setDoc } from "@/platform/persistence/firestoreDbModular"
import { setRequestAuditSinkForTests } from "@/platform/persistence/requestAuditFlush"
import { createMemoryRepositories } from "@/platform/persistence/spineRepositories"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import type { AuditEntry } from "@/platform/spine/store"

type Check = { ok: boolean; reason?: string }
type Contract = {
  NOT_EFFECT_COLLECTIONS: readonly string[]
  isEffectPath(path: string): boolean
  parseOutboxEntry(data: unknown): Check
  checkStagedRow(row: unknown, firmId: string): Check
  recoveredAuditRow(entryId: string, entry: Record<string, unknown>, recoveredAtMs: number): Record<string, unknown>
}

async function contract(): Promise<Contract> {
  const mod = (await import("@/platform/persistence/auditOutboxContract").catch(() => ({}))) as Partial<Contract>
  expect(mod.parseOutboxEntry, "platform/persistence/auditOutboxContract.ts").toBeTypeOf("function")
  return mod as Contract
}

const row = (firmId: string, over: Record<string, unknown> = {}) => ({
  id: `aud_${randomUUID()}`,
  firmId,
  action: "x",
  actorId: "u1",
  target: "matters/m1",
  classification: "internal",
  at: 1_700_000_000_000,
  ...over,
})

const entry = (over: Record<string, unknown> = {}) => ({
  v: 1,
  surface: "next",
  firmId: "firmA",
  actorId: "u1",
  route: "POST /api/d1/clients",
  requestAction: "create",
  operationId: "op-1",
  requestId: "req-1",
  seq: 0,
  effectPaths: ["entities/e1", "matter_client_search_index/i1"],
  rows: [row("firmA")],
  stagedAt: new Date(1_700_000_000_000),
  attempts: 0,
  ...over,
})

afterEach(() => {
  vi.unstubAllEnvs()
  setRequestAuditSinkForTests(null)
  resetRuntimeStoreForTests()
})

describe("F11 outbox contract (shared by Next and the reconciler)", () => {
  it("names the same non-effect collections as F10's fence, and treats everything else as an effect", async () => {
    const c = await contract()
    expect([...c.NOT_EFFECT_COLLECTIONS].sort()).toEqual([...UNFENCED_COLLECTIONS].sort())
    expect([...c.NOT_EFFECT_COLLECTIONS].sort()).toEqual(["audit_dead_letter", "audit_log", "audit_outbox", "idempotency_effects", "idempotency_keys"])
    expect(["entities/e1", "users/u1", "external:p1_dispatch"].map(c.isEffectPath)).toEqual([true, true, true])
    expect(["audit_log/a", "audit_outbox/b", "idempotency_effects/c"].map(c.isEffectPath)).toEqual([false, false, false])
  })

  it("accepts a well-formed entry; refuses a malformed one and one with no firm", async () => {
    const c = await contract()
    expect(c.parseOutboxEntry(entry()).ok).toBe(true)
    expect(c.parseOutboxEntry(entry({ rows: "x" }))).toMatchObject({ ok: false, reason: "entry_malformed" })
    expect(c.parseOutboxEntry(entry({ effectPaths: [] }))).toMatchObject({ ok: false, reason: "entry_malformed" })
    expect(c.parseOutboxEntry(entry({ stagedAt: "yesterday" }))).toMatchObject({ ok: false, reason: "entry_malformed" })
    expect(c.parseOutboxEntry(entry({ firmId: null }))).toMatchObject({ ok: false, reason: "entry_no_firm" })
    expect(c.parseOutboxEntry(null)).toMatchObject({ ok: false, reason: "entry_malformed" })
  })

  it("publishes only a well-formed row of the entry's own firm", async () => {
    const c = await contract()
    expect(c.checkStagedRow(row("firmA"), "firmA").ok).toBe(true)
    expect(c.checkStagedRow(row("firmB"), "firmA")).toMatchObject({ ok: false, reason: "cross_firm_row" })
    for (const bad of [
      row("firmA", { action: "" }),
      row("firmA", { actorId: 7 }),
      row("firmA", { id: "a/b" }),
      row("firmA", { id: undefined }),
      row("firmA", { classification: "secret" }),
      row("firmA", { at: "now" }),
      "row",
      [row("firmA")],
    ]) {
      expect(c.checkStagedRow(bad, "firmA")).toMatchObject({ ok: false, reason: "row_malformed" })
    }
  })

  it("the recovered row names the request's effect for a system actor on the request's behalf, failing closed on label", async () => {
    const c = await contract()
    const e = entry()
    const recovered = c.recoveredAuditRow("req-1_0", e, 1_700_000_900_000)
    expect(recovered).toEqual({
      id: "aud_outbox_req-1_0",
      firmId: "firmA",
      action: "request_effect_recovered",
      actorId: "system",
      onBehalfOf: "u1",
      target: "entities/e1",
      classification: "privileged-restricted",
      reason: "audit_unconfirmed",
      at: 1_700_000_000_000,
      recoveredAt: 1_700_000_900_000,
      route: "POST /api/d1/clients",
      requestAction: "create",
      operationId: "op-1",
      requestId: "req-1",
      effectPaths: ["entities/e1", "matter_client_search_index/i1"],
      stagedRowIds: [(e.rows[0] as { id: string }).id],
    })
  })
})

describe("F11 / F12 re-audit LOW-2: the memory dead letter lists by firm", () => {
  it("listByFirm returns only the firm's letters", async () => {
    const store = getRuntimeStore()
    const repos = createMemoryRepositories(store)
    await repos.auditDeadLetter.append({ row: row("firmA") as AuditEntry, reason: "a", deadLetteredAt: 1 })
    await repos.auditDeadLetter.append({ row: row("firmB") as AuditEntry, reason: "b", deadLetteredAt: 2 })
    expect((await repos.auditDeadLetter.listByFirm("firmA")).map((l) => l.reason)).toEqual(["a"])
    expect((await repos.auditDeadLetter.listByFirm("firmB")).map((l) => l.reason)).toEqual(["b"])
    await expect(repos.auditDeadLetter.listByFirm("")).rejects.toThrow()
  })
})

describe("F11: the request-audit sink seam cannot be reached outside the test runner", () => {
  it("setRequestAuditSinkForTests refuses unless VITEST=true", () => {
    vi.stubEnv("VITEST", "")
    expect(() => setRequestAuditSinkForTests(async () => undefined)).toThrow(/test runner/)
    vi.stubEnv("VITEST", "true")
    expect(() => setRequestAuditSinkForTests(async () => undefined)).not.toThrow()
  })
})

describe("F11 ruling 11: a client-SDK write inside a request is refused", () => {
  it("there is no transaction to stage the outbox in, so the write never reaches the network", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const app = initializeApp({ projectId: "demo-f11-client", apiKey: "fake" }, `f11-client-${randomUUID()}`)
    const clientDb = getFirestore(app)
    try {
      let outcome: unknown
      const res = await withSession(
        new Request("http://127.0.0.1/api/f11-probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actorId: "partner_a" }),
        }),
        async () => {
          const write = setDoc(doc(clientDb as never, "f11_probe", "x"), { n: 1 })
          outcome = await Promise.race([
            write.then(
              () => "written",
              (err: unknown) => (err instanceof Error ? err.message : String(err))
            ),
            new Promise((resolve) => setTimeout(() => resolve("still pending"), 1_500)),
          ])
          return Response.json({ ok: true })
        }
      )
      expect(res.status).toBe(200)
      expect(String(outcome)).toMatch(/audit F11/)
    } finally {
      await terminate(clientDb).catch(() => undefined)
      await deleteApp(app).catch(() => undefined)
    }
  })
})
