import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Behavioural dispatch coverage for /api/d2/ops-reporting (not a source grep):
// every allowlisted POST action must reach a handler without crashing, and every
// accepted GET view must reach a handler that answers with that same view name.
process.env.SIKANDER_AUTH_MODE = process.env.SIKANDER_AUTH_MODE ?? "insecure-dev"

import { GET, POST } from "@/app/api/d2/ops-reporting/route"
import { OPS_GET_VIEWS, OPS_POST_ACTIONS } from "@/app/api/d2/ops-reporting/dispatch"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"

// Messages that only come from programming errors (ReferenceError / TypeError) which the
// route's catch-all would otherwise turn into an innocuous-looking 400.
const CRASH_MESSAGE =
  /is not defined|Cannot read propert|Cannot set propert|is not a function|is not iterable|Cannot access '|of undefined|of null/

function label(i: number, name: string) {
  return `#${i} ${name.length > 72 ? `${name.slice(0, 72)}…(${name.length})` : name}`
}

let matterId = ""

beforeAll(async () => {
  resetRuntimeStoreForTests()
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title: "Ops dispatch coverage matter",
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  matterId = matter.id
  // Same seed as tests/api.ops-reporting.test.ts: workflow activity so the POST preamble
  // can build the matter's alert digest and governance rows and reach the action handlers.
  const doc = uploadDocument(store, {
    firmId: "firmA",
    matterId,
    bytes: Buffer.from("%PDF-ops-dispatch-coverage%"),
    sourceChannel: "web",
    classification: "internal",
    idempotencyKey: crypto.randomUUID(),
  })
  recordCaseNumber(store, matterId, "CP 1234", "SHC")
  const transition = await workflowPost(
    new Request("http://127.0.0.1/api/d1/document-workflow", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        action: "transition",
        actorId: "associate_a",
        documentId: doc.docId,
        nextStatus: "processing",
      }),
    })
  )
  expect(transition.status).toBe(200)
})

afterAll(() => {
  resetRuntimeStoreForTests()
})

describe("ops-reporting dispatch tables", () => {
  it("have no duplicate entries", () => {
    expect(new Set(OPS_POST_ACTIONS).size).toBe(OPS_POST_ACTIONS.length)
    expect(new Set(OPS_GET_VIEWS).size).toBe(OPS_GET_VIEWS.length)
  })

  it("still rejects actions outside the allowlist with 400 unknown action", async () => {
    const res = await POST(
      new Request("http://127.0.0.1/api/d2/ops-reporting", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ action: "not_a_real_ops_action", actorId: "partner_a", matterId }),
      })
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error?: string }).error).toBe("unknown action")
  })

  it("still rejects views outside the view table with 400", async () => {
    const res = await GET(
      new Request("http://127.0.0.1/api/d2/ops-reporting?view=not_a_real_ops_view&actorId=associate_a")
    )
    expect(res.status).toBe(400)
  })
})

describe("POST /api/d2/ops-reporting: every allowlisted action reaches a handler without crashing", () => {
  it.each(OPS_POST_ACTIONS.map((action, i) => [label(i, action), action] as const))(
    "%s",
    async (_label, action) => {
      const res = await POST(
        new Request("http://127.0.0.1/api/d2/ops-reporting", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ action, actorId: "partner_a", matterId }),
        })
      )
      const body = (await res.json()) as { error?: string }
      expect(res.status).toBeLessThan(500)
      expect(body.error).not.toBe("unknown action")
      // The shared preamble must let the request through to the action handler.
      expect(body.error).not.toBe("no alert digest exists for matter")
      expect(body.error).not.toBe("alert governance rows are unavailable for matter")
      expect(body.error ?? "").not.toMatch(CRASH_MESSAGE)
    },
    30_000
  )
})

describe("GET /api/d2/ops-reporting: every accepted view reaches its own handler", () => {
  it.each(OPS_GET_VIEWS.map((view, i) => [label(i, view), view] as const))(
    "%s",
    async (_label, view) => {
      const params = new URLSearchParams({ view, actorId: "associate_a", limit: "5", cursor: "0" })
      const res = await GET(new Request(`http://127.0.0.1/api/d2/ops-reporting?${params.toString()}`))
      const body = (await res.json()) as { view?: string; error?: string }
      expect(body.error ?? "").not.toMatch(CRASH_MESSAGE)
      expect(res.status).toBe(200)
      expect(body.view).toBe(view)
    },
    30_000
  )
})
