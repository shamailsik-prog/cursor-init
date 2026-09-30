import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// Behaviour fixes for /api/d2/ops-reporting defects found while typing the route
// (integration step 4). Each block failed before its fix.
process.env.SIKANDER_AUTH_MODE = process.env.SIKANDER_AUTH_MODE ?? "insecure-dev"

import { GET, POST } from "@/app/api/d2/ops-reporting/route"
import { opsReportingDiagnostics } from "@/app/api/d2/ops-reporting/dispatch"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { POST as workflowPost } from "@/app/api/d1/document-workflow/route"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { uploadDocument } from "@/services/d1-6/uploadDocument"
import { recordCaseNumber } from "@/services/d6-1/caseNumber"

type Json = Record<string, unknown>
type Row = Json & { id: string; matterId: string; provenanceTags?: string[] }

async function seedMatter(title: string): Promise<string> {
  const store = getRuntimeStore()
  const matter = createMatter(store, {
    firmId: "firmA",
    clientId: "client_a",
    title,
    courtId: "SHC",
    classification: "internal",
  })
  addMember(store, matter.id, "partner_a", "firmA")
  addMember(store, matter.id, "associate_a", "firmA")
  const doc = uploadDocument(store, {
    firmId: "firmA",
    matterId: matter.id,
    bytes: Buffer.from(`%PDF-${title}%`),
    sourceChannel: "web",
    classification: "internal",
    idempotencyKey: crypto.randomUUID(),
  })
  recordCaseNumber(store, matter.id, "CP 1234", "SHC")
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
  return matter.id
}

async function postAction(action: string, matterId: string, extra: Json = {}) {
  const res = await POST(
    new Request("http://127.0.0.1/api/d2/ops-reporting", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action, actorId: "partner_a", matterId, ...extra }),
    })
  )
  return { res, body: (await res.json()) as { error?: string; code?: string; result?: Json } }
}

function collection(name: string): Map<string, Row> {
  const map = (getRuntimeStore() as unknown as Record<string, unknown>)[name]
  if (!(map instanceof Map)) throw new Error(`no store collection ${name.slice(0, 60)}`)
  return map as Map<string, Row>
}

function rowsFor(name: string, matterId: string): Row[] {
  return [...collection(name).values()].filter((row) => row.matterId === matterId)
}

let onError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  onError = vi.spyOn(opsReportingDiagnostics, "onError").mockImplementation(() => {})
})
afterEach(() => {
  const crashes = onError.mock.calls
    .map(([err]) => err)
    .filter((err) => err instanceof TypeError || err instanceof ReferenceError)
  onError.mockRestore()
  expect(crashes).toEqual([])
})
beforeAll(() => resetRuntimeStoreForTests())
afterAll(() => resetRuntimeStoreForTests())

const ROUTE = path.resolve(__dirname, "../app/api/d2/ops-reporting/route.ts")
const short = (s: string) => (s.length > 60 ? `${s.slice(0, 60)}…(${s.length})` : s)

// The POST preamble resolves each lattice row as
//   store.<K>.get(id) ?? governance.<seedArray>?.find(sameMatter) ?? repos.<K>.get(id)
// so a seed array used as the fallback for collection K must only hold rows the seed
// writes to K. Two 499/500 acknowledgment arrays held the *sibling* lineage's rows
// ("seal verifications" vs "seal verification"), so finalize/acknowledge could copy a
// sibling row, id and all, into its own collection whenever K had no row yet.
describe("ops-reporting governance fallbacks read only their own collection", () => {
  it("every governance seed array used as a fallback for K holds only rows written to K", () => {
    const text = readFileSync(ROUTE, "utf8")
    const sf = ts.createSourceFile(ROUTE, text, ts.ScriptTarget.Latest, true)
    const pushed = new Map<string, Set<string>>() // array -> pushed identifiers
    const writtenTo = new Map<string, Set<string>>() // identifier -> collections
    const consumed = new Map<string, Set<string>>() // array -> collections it backs
    const add = (m: Map<string, Set<string>>, k: string, v: string) => {
      if (!m.has(k)) m.set(k, new Set())
      m.get(k)!.add(v)
    }
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const meth = n.expression.name.text
        const obj = n.expression.expression
        const arg = n.arguments[meth === "set" ? 1 : 0]
        if (meth === "push" && ts.isIdentifier(obj) && arg && ts.isIdentifier(arg)) add(pushed, obj.text, arg.text)
        if (
          (meth === "upsert" || meth === "set") &&
          ts.isPropertyAccessExpression(obj) &&
          ["store", "repos"].includes(obj.expression.getText()) &&
          arg &&
          ts.isIdentifier(arg)
        )
          add(writtenTo, arg.text, obj.name.text)
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        const chain = n.getText(sf)
        const k = /^\s*store\s*\.\s*(\w+)\s*\.\s*get\(/.exec(chain)?.[1]
        const arr = /governance\s*\.\s*(\w+)\s*\?\.\s*find\(/.exec(chain)?.[1]
        if (k && arr) add(consumed, arr, k)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(consumed.size).toBeGreaterThan(4)
    const violations: string[] = []
    for (const [arr, backs] of consumed) {
      const cols = new Set([...(pushed.get(arr) ?? [])].flatMap((id) => [...(writtenTo.get(id) ?? [])]))
      for (const k of backs)
        for (const c of cols) if (c !== k) violations.push(`${short(arr)} backs ${short(k)} but holds ${short(c)} rows`)
    }
    expect(violations).toEqual([])
  })
})
