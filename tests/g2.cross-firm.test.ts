import { randomUUID } from "node:crypto"
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * Gate G-2 (L18 §10, web and WhatsApp side): "two test firms seeded; every
 * read function in D1-1, D1-2, D3-1, D5-1, D2-1 attempted cross-firm through
 * web and WhatsApp returns deny".
 *
 * Firm A and firm B are seeded through the real route handlers (one user per
 * role in each firm; clients, matters, documents, workflow events, reporting
 * rows). Every firm-B role then attempts every read path against firm A: by
 * id, by list, by filter, and by spoofing the tenant (X-Firm-Id, firmId) or
 * the identity (actorId/userId). Each attempt must be refused (a 4xx) when it
 * names a firm-A object, and no response may contain any firm-A identifier or
 * name. A firm-A control request on the same path must show firm-A data, so
 * the leak check is known to be live.
 *
 * Callers authenticate in firebase mode (verified ID token + X-Firm-Id), with
 * firebase-admin's verifier stubbed to a fixed token table.
 *
 * The read paths are derived from the route sources (exported methods,
 * `view` values, `action` values, WhatsApp command grammar). Every discovered
 * path must be in READ_PATHS (tested) or in a module mapped out of the G-2
 * services; anything unlisted fails. Service functions the spec names but the
 * code does not have yet are listed as NOT_BUILT and printed, never silently
 * passed. Runs in memory persistence always, and in Firestore persistence too
 * when the emulator is up (ci_gates/gate_g2.sh). `G2_COVERAGE_OUT` receives
 * the coverage rows as JSON.
 */

const verifyIdToken = vi.fn()
vi.mock("firebase-admin/app", () => ({
  getApps: () => [],
  initializeApp: () => ({ name: "g2-test-app" }),
  applicationDefault: () => ({}),
}))
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }))

import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import * as clientsRoute from "@/app/api/d1/clients/route"
import * as reportingRoute from "@/app/api/d1/reporting/route"
import * as mattersRoute from "@/app/api/d1/matters/route"
import * as documentsRoute from "@/app/api/d1/documents/route"
import * as workflowRoute from "@/app/api/d1/document-workflow/route"
import * as courtOpsRoute from "@/app/api/d2/court-ops/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { resetSessionStateForTests } from "@/platform/p5/session"
import { getRuntimeRepositories, setFirestorePersistenceForTests } from "@/platform/persistence/runtimeRepositories"
import type { Role, User } from "@/platform/spine/store"

// ---------------------------------------------------------------------------
// Firms, users, tokens
// ---------------------------------------------------------------------------

const FIRM_A = "firmA"
const FIRM_B = "firmB"
const ROLES: readonly Role[] = ["partner", "associate", "clerk", "intern", "accounts", "client"]

const FIRM_A_USERS: User[] = [
  { id: "partner_a", firmId: FIRM_A, role: "partner", clearanceLevel: "privileged-restricted" },
  { id: "associate_a", firmId: FIRM_A, role: "associate", clearanceLevel: "privileged" },
  { id: "clerk_a", firmId: FIRM_A, role: "clerk", clearanceLevel: "confidential" },
  { id: "intern_a", firmId: FIRM_A, role: "intern", clearanceLevel: "internal" },
  { id: "accounts_a", firmId: FIRM_A, role: "accounts", clearanceLevel: "internal" },
  { id: "client_a", firmId: FIRM_A, role: "client", clearanceLevel: "internal" },
]
/** Every firm-B caller holds the top clearance, so only the firm boundary can refuse it. */
const FIRM_B_USERS: User[] = ROLES.map((role) => ({
  id: `${role}_b`,
  firmId: FIRM_B,
  role,
  clearanceLevel: "privileged-restricted",
}))
const tokenOf = (uid: string) => `g2-token-${uid}`

function installVerifier(): void {
  const table = new Map([...FIRM_A_USERS, ...FIRM_B_USERS].map((u) => [tokenOf(u.id), u]))
  verifyIdToken.mockReset()
  verifyIdToken.mockImplementation(async (token: string) => {
    const u = table.get(token)
    if (!u) throw new Error("invalid token")
    return { uid: u.id, firmId: u.firmId, role: u.role, clearanceLevel: u.clearanceLevel }
  })
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Handler = (request: Request) => Promise<Response>
type RouteModule = { GET?: Handler; POST?: Handler }
type Call = {
  route: string
  method: "GET" | "POST"
  query?: Record<string, string>
  body?: Record<string, unknown>
  /** Overrides the caller's own firm in X-Firm-Id. */
  firmHeader?: string
  idempotencyKey?: string
}

const MODULES: Record<string, RouteModule> = {
  "/api/d1/clients": clientsRoute,
  "/api/d1/reporting": reportingRoute,
  "/api/d1/matters": mattersRoute,
  "/api/d1/documents": documentsRoute,
  "/api/d1/document-workflow": workflowRoute,
  "/api/d2/court-ops": courtOpsRoute,
}

async function send(caller: User, call: Call): Promise<{ status: number; body: unknown; text: string }> {
  const url = new URL(`http://127.0.0.1${call.route}`)
  for (const [k, v] of Object.entries(call.query ?? {})) url.searchParams.set(k, v)
  const headers = new Headers({
    Authorization: `Bearer ${tokenOf(caller.id)}`,
    "X-Firm-Id": call.firmHeader ?? caller.firmId,
  })
  let init: RequestInit = { method: call.method, headers }
  if (call.method === "POST") {
    headers.set("Content-Type", "application/json")
    headers.set("Idempotency-Key", call.idempotencyKey ?? randomUUID())
    init = { ...init, body: JSON.stringify(call.body ?? {}) }
  }
  const handler = MODULES[call.route]?.[call.method]
  if (!handler) throw new Error(`no handler for ${call.method} ${call.route}`)
  const res = await handler(new Request(url, init))
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // non-JSON body: kept as text
  }
  return { status: res.status, body, text }
}

async function ok<T>(caller: User, call: Call): Promise<T> {
  const res = await send(caller, call)
  if (res.status !== 200) throw new Error(`seed ${call.method} ${call.route} as ${caller.id} → ${res.status} ${res.text}`)
  return res.body as T
}

// ---------------------------------------------------------------------------
// Seed: the same shape in both firms, through the real handlers
// ---------------------------------------------------------------------------

type FirmSeed = {
  entityId: string
  entityName: string
  cnic: string
  phone: string
  matterId: string
  matterTitle: string
  titleTerm: string
  docIds: string[]
  contentHashes: string[]
  reviewDocId: string
  bytes: string
}

const user = (id: string) => [...FIRM_A_USERS, ...FIRM_B_USERS].find((u) => u.id === id)!

async function seedFirm(firmId: string, tag: "alpha" | "beta"): Promise<FirmSeed> {
  const s = firmId === FIRM_A ? "a" : "b"
  const partner = user(`partner_${s}`)
  const titleTerm = `g2${tag}${randomUUID().slice(0, 6)}`
  const entityName = `${tag.toUpperCase()}-Client-${titleTerm}`
  const cnic = firmId === FIRM_A ? "4210111111111" : "3520222222222"
  const phone = firmId === FIRM_A ? "+923001110001" : "+923009990009"
  const client = await ok<{ result: { entity: { id: string } } }>(partner, {
    route: "/api/d1/clients",
    method: "POST",
    body: { action: "create", firmId, canonicalName: entityName, cnic, phone, classification: "confidential" },
  })
  const matterTitle = `${titleTerm} constitutional petition`
  const matter = await ok<{ result: { matter: { id: string } } }>(partner, {
    route: "/api/d1/matters",
    method: "POST",
    body: {
      action: "create",
      firmId,
      clientId: `client_${s}`,
      title: matterTitle,
      courtId: "SHC",
      classification: "confidential",
      memberUserIds: [`associate_${s}`, `clerk_${s}`, `intern_${s}`],
    },
  })
  const matterId = matter.result.matter.id
  const bytes = `G2 ${tag} privileged brief ${titleTerm}`
  const docIds: string[] = []
  const contentHashes: string[] = []
  for (const [i, m] of [matterId, null, matterId].entries()) {
    const doc = await ok<{ result: { doc: { id: string; contentHash: string } } }>(partner, {
      route: "/api/d1/documents",
      method: "POST",
      body: {
        action: "ingest",
        firmId,
        matterId: m,
        contentBase64: Buffer.from(`${bytes} #${i}`).toString("base64"),
        sourceChannel: "web",
        classification: "confidential",
      },
    })
    docIds.push(doc.result.doc.id)
    contentHashes.push(doc.result.doc.contentHash)
  }
  const reviewDocId = docIds[2]
  // A workflow event on the matter (timeline) and a review blocker (court-ops / WhatsApp /ops queue).
  await ok(partner, {
    route: "/api/d1/document-workflow",
    method: "POST",
    body: { action: "transition", documentId: reviewDocId, nextStatus: "review_required", reason: `${tag} review` },
  })
  await ok(partner, {
    route: "/api/d1/reporting",
    method: "POST",
    body: { action: "record_matter_report_export", matterId, exportFormat: "pdf", exportScope: "summary" },
  })
  return {
    entityId: client.result.entity.id,
    entityName,
    cnic,
    phone,
    matterId,
    matterTitle,
    titleTerm,
    docIds,
    contentHashes,
    reviewDocId,
    bytes,
  }
}

/** Every firm-A identifier and name. None may appear in any firm-B response. */
function firmAMarkers(a: FirmSeed): string[] {
  return [
    FIRM_A,
    a.entityId,
    a.entityName,
    a.cnic,
    a.phone,
    a.matterId,
    a.titleTerm,
    ...a.docIds,
    ...a.contentHashes,
    ...FIRM_A_USERS.map((u) => u.id),
  ]
}

// ---------------------------------------------------------------------------
// Read paths of the G-2 services
// ---------------------------------------------------------------------------

type Service = "D1-1" | "D1-2" | "D3-1" | "D5-1" | "D2-1" | "D6-1"
type Channel = "web" | "whatsapp"
type Attack = { label: string; call: Call; mustDeny: boolean }
type ReadPath = {
  service: Service
  channel: Channel
  route: string
  method: "GET" | "POST"
  /** "list", "view=<v>", "action=<a>" or "command=/<c>". */
  selector: string
  /** "read": returns tenant data; "write": mutates, but its response echoes the record (tenant-spoof and firm-A aims tested). */
  kind: "read" | "write"
  note?: string
  /** A firm-B caller's own-scope request; the tenant/identity spoofs are derived from it. */
  base: (b: FirmSeed) => Call
  /** Requests aimed at firm-A objects (by id / by filter). */
  aimed: (a: FirmSeed, b: FirmSeed) => Attack[]
  /** Firm-A request that must return 200 and show firm-A data (proves the path and the leak check are live). */
  control?: { as: string; call: (a: FirmSeed) => Call; shows: (a: FirmSeed) => string }
}

const get = (route: string, query: Record<string, string> = {}): Call => ({ route, method: "GET", query })
const post = (route: string, body: Record<string, unknown>): Call => ({ route, method: "POST", body })
const deny = (label: string, call: Call): Attack => ({ label, call, mustDeny: true })
const filter = (label: string, call: Call): Attack => ({ label, call, mustDeny: false })

const WA = (command: string) => post("/api/d2/court-ops", { action: "whatsapp_command", command })

const READ_PATHS: ReadPath[] = [
  // D1-1 Client Service (Module 1 client file; Module 43 client reporting)
  {
    service: "D1-1", channel: "web", route: "/api/d1/clients", method: "GET", selector: "list", kind: "read",
    base: () => get("/api/d1/clients", { limit: "100" }),
    aimed: () => [filter("cursor past firm B", get("/api/d1/clients", { limit: "100", cursor: "1" }))],
    control: { as: "partner_a", call: () => get("/api/d1/clients", { limit: "100" }), shows: (a) => a.entityId },
  },
  {
    service: "D1-1", channel: "web", route: "/api/d1/clients", method: "POST", selector: "action=conflict_check", kind: "read",
    base: (b) => post("/api/d1/clients", { action: "conflict_check", firmId: FIRM_B, entityId: b.entityId }),
    aimed: (a) => [deny("firm-A entityId", post("/api/d1/clients", { action: "conflict_check", firmId: FIRM_B, entityId: a.entityId }))],
    control: { as: "partner_a", call: (a) => post("/api/d1/clients", { action: "conflict_check", firmId: FIRM_A, entityId: a.entityId }), shows: (a) => a.entityId },
  },
  {
    service: "D1-1", channel: "web", route: "/api/d1/clients", method: "POST", selector: "action=create", kind: "write",
    base: () => post("/api/d1/clients", { action: "create", firmId: FIRM_B, canonicalName: "Beta Probe", cnic: "3520233333333", phone: "+923005550000", classification: "internal" }),
    aimed: (a) => [filter("same CNIC as a firm-A client (no cross-firm link)", post("/api/d1/clients", { action: "create", firmId: FIRM_B, canonicalName: "Beta Twin", cnic: a.cnic, phone: "+923005550001", classification: "internal" }))],
  },
  {
    service: "D1-1", channel: "web", route: "/api/d1/reporting", method: "GET", selector: "view=search", kind: "read",
    base: () => get("/api/d1/reporting", { view: "search" }),
    aimed: (a) => [
      filter("q=firm-A title term", get("/api/d1/reporting", { view: "search", q: a.titleTerm })),
      filter("rowType=client q=firm-A client", get("/api/d1/reporting", { view: "search", rowType: "client", q: a.titleTerm })),
      filter("rowType=matter", get("/api/d1/reporting", { view: "search", rowType: "matter" })),
    ],
    control: { as: "partner_a", call: (a) => get("/api/d1/reporting", { view: "search", q: a.titleTerm }), shows: (a) => a.matterId },
  },
  {
    service: "D1-1", channel: "web", route: "/api/d1/reporting", method: "GET", selector: "view=matter_report_export_analytics", kind: "read",
    base: () => get("/api/d1/reporting", { view: "matter_report_export_analytics" }),
    aimed: (a) => [filter("matterId=firm-A matter", get("/api/d1/reporting", { view: "matter_report_export_analytics", matterId: a.matterId }))],
    control: { as: "partner_a", call: () => get("/api/d1/reporting", { view: "matter_report_export_analytics" }), shows: (a) => a.matterId },
  },
  {
    service: "D1-1", channel: "web", route: "/api/d1/reporting", method: "GET", selector: "view=matter_report_relevance_snapshots", kind: "read",
    base: () => get("/api/d1/reporting", { view: "matter_report_relevance_snapshots" }),
    aimed: (a) => [
      filter("matterId=firm-A matter", get("/api/d1/reporting", { view: "matter_report_relevance_snapshots", matterId: a.matterId })),
      filter("scoreBand/freshness filters", get("/api/d1/reporting", { view: "matter_report_relevance_snapshots", scoreBand: "low", freshnessStatus: "fresh" })),
    ],
    control: { as: "partner_a", call: () => get("/api/d1/reporting", { view: "matter_report_relevance_snapshots" }), shows: (a) => a.matterId },
  },
  {
    service: "D1-1", channel: "web", route: "/api/d1/reporting", method: "POST", selector: "action=record_matter_report_export", kind: "write",
    base: (b) => post("/api/d1/reporting", { action: "record_matter_report_export", matterId: b.matterId, exportFormat: "csv", exportScope: "summary" }),
    aimed: (a) => [deny("firm-A matterId", post("/api/d1/reporting", { action: "record_matter_report_export", matterId: a.matterId, exportFormat: "csv", exportScope: "summary" }))],
    control: { as: "partner_a", call: (a) => post("/api/d1/reporting", { action: "record_matter_report_export", matterId: a.matterId, exportFormat: "json", exportScope: "detailed" }), shows: (a) => a.matterId },
  },
  {
    service: "D1-1", channel: "web", route: "/api/d1/reporting", method: "POST", selector: "action=recompute_matter_report_relevance", kind: "write",
    base: (b) => post("/api/d1/reporting", { action: "recompute_matter_report_relevance", matterId: b.matterId }),
    aimed: (a) => [deny("firm-A matterId", post("/api/d1/reporting", { action: "recompute_matter_report_relevance", matterId: a.matterId }))],
    control: { as: "partner_a", call: (a) => post("/api/d1/reporting", { action: "recompute_matter_report_relevance", matterId: a.matterId }), shows: (a) => a.matterId },
  },

  // D1-2 Matter Service
  {
    service: "D1-2", channel: "web", route: "/api/d1/matters", method: "GET", selector: "list", kind: "read",
    base: () => get("/api/d1/matters", { limit: "100" }),
    aimed: () => [filter("cursor past firm B", get("/api/d1/matters", { limit: "100", cursor: "1" }))],
    control: { as: "clerk_a", call: () => get("/api/d1/matters", { limit: "100" }), shows: (a) => a.matterTitle },
  },
  {
    service: "D1-2", channel: "web", route: "/api/d1/matters", method: "POST", selector: "action=confirm_engagement", kind: "write",
    base: (b) => post("/api/d1/matters", { action: "confirm_engagement", matterId: b.matterId }),
    aimed: (a) => [deny("firm-A matterId", post("/api/d1/matters", { action: "confirm_engagement", matterId: a.matterId }))],
    control: { as: "partner_a", call: (a) => post("/api/d1/matters", { action: "confirm_engagement", matterId: a.matterId }), shows: (a) => a.matterTitle },
  },
  {
    service: "D1-2", channel: "web", route: "/api/d1/matters", method: "POST", selector: "action=record_case_number", kind: "write",
    base: (b) => post("/api/d1/matters", { action: "record_case_number", matterId: b.matterId, raw: "C.P. 1/2026", courtId: "SHC" }),
    aimed: (a) => [deny("firm-A matterId", post("/api/d1/matters", { action: "record_case_number", matterId: a.matterId, raw: "C.P. 1/2026", courtId: "SHC" }))],
    control: { as: "partner_a", call: (a) => post("/api/d1/matters", { action: "record_case_number", matterId: a.matterId, raw: "C.P. 2/2026", courtId: "SHC" }), shows: (a) => a.matterTitle },
  },
  {
    service: "D1-2", channel: "web", route: "/api/d1/matters", method: "POST", selector: "action=create", kind: "write",
    base: () => post("/api/d1/matters", { action: "create", firmId: FIRM_B, clientId: "client_b", title: "Beta probe matter", courtId: "SHC", classification: "internal" }),
    aimed: () => [
      deny("firm-A clientId", post("/api/d1/matters", { action: "create", firmId: FIRM_B, clientId: "client_a", title: "Beta probe", courtId: "SHC", classification: "internal" })),
      deny("firm-A member", post("/api/d1/matters", { action: "create", firmId: FIRM_B, clientId: "client_b", title: "Beta probe", courtId: "SHC", classification: "internal", memberUserIds: ["clerk_a"] })),
    ],
  },

  // D3-1 Document Vault (read path; L7.1 staging/review workflow)
  {
    service: "D3-1", channel: "web", route: "/api/d1/documents", method: "GET", selector: "list", kind: "read",
    base: () => get("/api/d1/documents", { limit: "100" }),
    aimed: (a) => [filter("matterId=firm-A matter", get("/api/d1/documents", { limit: "100", matterId: a.matterId }))],
    control: { as: "partner_a", call: (a) => get("/api/d1/documents", { limit: "100", matterId: a.matterId }), shows: (a) => a.docIds[0] },
  },
  {
    service: "D3-1", channel: "web", route: "/api/d1/documents", method: "POST", selector: "action=ingest", kind: "write",
    note: "D1-6 ingest write path; tested because its response returns the stored document",
    base: () => post("/api/d1/documents", { action: "ingest", firmId: FIRM_B, contentBase64: Buffer.from(`beta probe ${randomUUID()}`).toString("base64"), sourceChannel: "web", classification: "internal" }),
    aimed: (a) => [
      deny("firm-A matterId", post("/api/d1/documents", { action: "ingest", firmId: FIRM_B, matterId: a.matterId, contentBase64: Buffer.from("x").toString("base64"), sourceChannel: "web", classification: "confidential" })),
      filter("byte-identical to a firm-A document (no cross-firm dedupe)", post("/api/d1/documents", { action: "ingest", firmId: FIRM_B, contentBase64: Buffer.from(`${a.bytes} #1`).toString("base64"), sourceChannel: "web", classification: "confidential" })),
    ],
  },
  {
    service: "D3-1", channel: "web", route: "/api/d1/document-workflow", method: "GET", selector: "view=queue", kind: "read",
    base: () => get("/api/d1/document-workflow", { view: "queue", limit: "100" }),
    aimed: (a) => [
      filter("matterId=firm-A matter", get("/api/d1/document-workflow", { view: "queue", matterId: a.matterId })),
      filter("status=review_required", get("/api/d1/document-workflow", { status: "review_required" })),
    ],
    control: { as: "partner_a", call: () => get("/api/d1/document-workflow", { view: "queue", limit: "100" }), shows: (a) => a.reviewDocId },
  },
  {
    service: "D3-1", channel: "web", route: "/api/d1/document-workflow", method: "GET", selector: "view=timeline", kind: "read",
    base: (b) => get("/api/d1/document-workflow", { view: "timeline", matterId: b.matterId }),
    aimed: (a) => [deny("firm-A matterId", get("/api/d1/document-workflow", { view: "timeline", matterId: a.matterId }))],
    control: { as: "partner_a", call: (a) => get("/api/d1/document-workflow", { view: "timeline", matterId: a.matterId }), shows: (a) => a.reviewDocId },
  },
  {
    service: "D3-1", channel: "web", route: "/api/d1/document-workflow", method: "POST", selector: "action=transition", kind: "write",
    base: (b) => post("/api/d1/document-workflow", { action: "transition", documentId: b.docIds[0], nextStatus: "processing" }),
    aimed: (a) => a.docIds.map((id, i) => deny(`firm-A document #${i}`, post("/api/d1/document-workflow", { action: "transition", documentId: id, nextStatus: "processing" }))),
    control: { as: "partner_a", call: (a) => post("/api/d1/document-workflow", { action: "transition", documentId: a.docIds[1], nextStatus: "processing" }), shows: (a) => a.docIds[1] },
  },
  {
    service: "D3-1", channel: "web", route: "/api/d1/document-workflow", method: "POST", selector: "action=assign_reviewer", kind: "write",
    base: (b) => post("/api/d1/document-workflow", { action: "assign_reviewer", documentId: b.docIds[1], reviewerId: "clerk_b" }),
    aimed: (a, b) => [
      deny("firm-A document", post("/api/d1/document-workflow", { action: "assign_reviewer", documentId: a.docIds[0], reviewerId: "clerk_b" })),
      deny("firm-A reviewer on a firm-B document", post("/api/d1/document-workflow", { action: "assign_reviewer", documentId: b.docIds[1], reviewerId: "clerk_a" })),
    ],
    control: { as: "partner_a", call: (a) => post("/api/d1/document-workflow", { action: "assign_reviewer", documentId: a.docIds[0], reviewerId: "clerk_a" }), shows: (a) => a.docIds[0] },
  },
  {
    service: "D3-1", channel: "web", route: "/api/d1/document-workflow", method: "POST", selector: "action=review_decision", kind: "write",
    base: (b) => post("/api/d1/document-workflow", { action: "review_decision", documentId: b.reviewDocId, decision: "confirm_classification" }),
    aimed: (a) => [deny("firm-A document", post("/api/d1/document-workflow", { action: "review_decision", documentId: a.reviewDocId, decision: "declassify", nextClassification: "public" }))],
    // docIds[0] is put in review by the assign_reviewer control above; reviewDocId stays in review for /ops queue.
    control: { as: "partner_a", call: (a) => post("/api/d1/document-workflow", { action: "review_decision", documentId: a.docIds[0], decision: "confirm_classification" }), shows: (a) => a.docIds[0] },
  },

  // D2-1 WhatsApp Channel (Module 36 commands), driven as the linked caller's session
  {
    service: "D2-1", channel: "whatsapp", route: "/api/d2/court-ops", method: "POST", selector: "command=/matters", kind: "read",
    base: () => WA("/matters"),
    aimed: () => [],
    control: { as: "clerk_a", call: () => WA("/matters"), shows: (a) => a.matterTitle },
  },
  {
    service: "D5-1", channel: "whatsapp", route: "/api/d2/court-ops", method: "POST", selector: "command=/research", kind: "read",
    note: "D5-1 search through the D2-1 channel; the handler returns no corpus rows yet",
    base: () => WA("/research PPC 302"),
    aimed: (a) => [filter("query = firm-A matter title", WA(`/research ${a.matterTitle}`))],
  },
  {
    service: "D6-1", channel: "whatsapp", route: "/api/d2/court-ops", method: "POST", selector: "command=/ops", kind: "read",
    note: "/ops queue (court-ops queue) through the D2-1 channel",
    base: () => WA("/ops queue"),
    aimed: () => [],
    control: { as: "clerk_a", call: () => WA("/ops queue"), shows: (a) => a.reviewDocId },
  },
  {
    service: "D6-1", channel: "web", route: "/api/d2/court-ops", method: "GET", selector: "view=court_ops_queue", kind: "read",
    note: "court-ops queue; the web twin of WhatsApp /ops queue",
    base: () => get("/api/d2/court-ops", { limit: "100" }),
    aimed: (a) => [filter("matterId=firm-A matter", get("/api/d2/court-ops", { matterId: a.matterId }))],
    control: { as: "clerk_a", call: () => get("/api/d2/court-ops", { limit: "100" }), shows: (a) => a.reviewDocId },
  },
]

/** Selectors of in-scope modules that are writes with no firm-A read surface, reviewed and outside G-2's read set. */
const OUT_OF_SCOPE_SELECTORS: Record<string, string> = {
  "POST /api/d2/court-ops action=acknowledge_item": "D6-1 court-ops write",
  "POST /api/d2/court-ops action=resolve_follow_up": "D6-1 court-ops write",
  "POST /api/d2/court-ops action=resolve_workflow": "D6-1 court-ops write",
}

/** Route modules outside D1-1, D1-2, D3-1, D5-1, D2-1 (not part of the G-2 read set). */
const OUT_OF_SCOPE_MODULES: Record<string, string> = {
  "/api/d2/ops-reporting": "D2-3 web ops reporting",
  "/api/d4/drafts": "D4-1 drafting factory",
  "/api/d4/filings": "D4-3 filing packages",
  "/api/p1/committee-brain": "P1 AI gateway",
  "/api/p5/tenancy": "P5 tenancy administration",
  "/api/g0/monitor": "G-0 public health (no tenant data)",
  "/api/g0/normalise": "G-0 case-number normaliser (no tenant data)",
}

/** Spec read functions of the G-2 services (L18 §3 service table, §8 WhatsApp grammar) with no code yet. */
const NOT_BUILT: Array<{ service: Service; channel: Channel; path: string; note: string }> = [
  { service: "D1-1", channel: "web", path: "/api/d1/client/* read by id (client file)", note: "only list + conflict_check exist" },
  { service: "D1-2", channel: "web", path: "/api/d1/matter/* read by id; relevant_law_dates (L17.1); entity resolution views (L17.2)", note: "only list exists" },
  { service: "D3-1", channel: "web", path: "/api/d3/vault/* document read/download by id, versions, exports, share links, Ghost Archive, loose vault view", note: "document_versions has rules but no read route" },
  { service: "D5-1", channel: "web", path: "/api/d5/research/* search, arguments, compendium, precedent discovery, authority viewer", note: "services/d5-1 searchCorpus is not routed" },
  { service: "D2-1", channel: "whatsapp", path: "/api/d2/whatsapp/* inbound webhook with phone-number to user binding", note: "commands run as an authenticated session via /api/d2/court-ops" },
  { service: "D2-1", channel: "whatsapp", path: "/matters <Query|CaseRef>", note: "grammar accepts bare /matters only" },
  { service: "D2-1", channel: "whatsapp", path: "/hearings [Date]", note: "not in the command grammar" },
  { service: "D2-1", channel: "whatsapp", path: "/clients [Query]", note: "not in the command grammar" },
  { service: "D2-1", channel: "whatsapp", path: "/drafts [CaseRef]", note: "not in the command grammar" },
  { service: "D2-1", channel: "whatsapp", path: "open N (numbered-list reply)", note: "not in the command grammar" },
]

const selectorKey = (p: { method: string; route: string; selector: string }) => `${p.method} ${p.route} ${p.selector}`

// ---------------------------------------------------------------------------
// Discovery: read paths from the route sources
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..")

function routeModules(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name === "route.ts") out.push(full)
    }
  }
  walk(path.join(ROOT, "app/api"))
  return out.map((f) => `/${path.relative(ROOT, path.dirname(f)).split(path.sep).join("/").replace(/^app\//, "")}`).sort()
}

const literals = (src: string, re: RegExp) => [...src.matchAll(re)].map((m) => m[1])

/** Discovered read/act selectors of one route module: methods, `view` values, `action` values, WhatsApp commands. */
function discover(route: string): string[] {
  const src = readFileSync(path.join(ROOT, "app", route, "route.ts"), "utf8")
  const found = new Set<string>()
  const methods = literals(src, /^export async function (GET|POST|PUT|PATCH|DELETE)\b/gm)
  if (methods.includes("GET")) {
    const views = new Set([
      ...literals(src, /\bview\s*===\s*"([\w-]+)"/g),
      ...literals(src, /\bview:\s*"([\w-]+)"/g),
      ...literals(src, /get\("view"\)\s*\?\?\s*"([\w-]+)"/g),
      ...[...src.matchAll(/type \w*View\s*=\s*([^\n]+)/g)].flatMap((m) => literals(m[1], /"([\w-]+)"/g)),
    ])
    if (views.size === 0) found.add(`GET ${route} list`)
    for (const v of views) found.add(`GET ${route} view=${v}`)
  }
  if (methods.includes("POST")) {
    const actions = new Set([
      ...literals(src, /action:\s*z\.literal\("([\w-]+)"\)/g),
      ...literals(src, /\baction\s*===\s*"([\w-]+)"/g),
      ...literals(src, /^\s*action:\s*"([\w-]+)"\s*$/gm),
    ])
    for (const a of actions) {
      if (a === "whatsapp_command") {
        const grammar = src.slice(src.indexOf("function validateWhatsAppCommand"))
        const body = grammar.slice(0, grammar.indexOf("\n}\n"))
        for (const c of new Set(literals(body, /\/\^\\\/(\w+)/g))) found.add(`POST ${route} command=/${c}`)
      } else {
        found.add(`POST ${route} action=${a}`)
      }
    }
  }
  for (const m of methods.filter((x) => x !== "GET" && x !== "POST")) found.add(`${m} ${route} method`)
  return [...found].sort()
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

type CoverageRow = { suite: string; mode: string; service: string; channel: string; path: string; status: string; attempts: number; allowed: number; note?: string }
const coverage: CoverageRow[] = []

/** The tenant and identity spoofs of a firm-B caller's base request. */
function spoofs(base: Call): Attack[] {
  const withParam = (key: string, value: string): Call =>
    base.method === "GET"
      ? { ...base, query: { ...base.query, [key]: value } }
      : { ...base, body: { ...base.body, [key]: value } }
  return [
    deny("X-Firm-Id=firmA", { ...base, firmHeader: FIRM_A }),
    deny("firmId=firmA", withParam("firmId", FIRM_A)),
    deny("actorId=partner_a", withParam("actorId", "partner_a")),
    ...(base.method === "GET" ? [deny("userId=client_a", withParam("userId", "client_a"))] : []),
  ]
}

const MODES = ["memory", ...(process.env.FIRESTORE_EMULATOR_HOST ? ["firestore"] : [])] as const

afterAll(() => {
  const out = process.env.G2_COVERAGE_OUT
  if (!out) return
  const rows: CoverageRow[] = [
    ...coverage,
    ...NOT_BUILT.map((n) => ({ suite: "next", mode: "-", service: n.service, channel: n.channel, path: n.path, status: "not_built", attempts: 0, allowed: 0, note: n.note })),
    ...Object.entries(OUT_OF_SCOPE_MODULES).map(([route, why]) => ({ suite: "next", mode: "-", service: why.split(" ")[0], channel: "web", path: `${route} (${discover(route).length} read/act selectors)`, status: "out_of_scope", attempts: 0, allowed: 0, note: why })),
    ...Object.entries(OUT_OF_SCOPE_SELECTORS).map(([sel, why]) => ({ suite: "next", mode: "-", service: why.split(" ")[0], channel: "web", path: sel, status: "out_of_scope", attempts: 0, allowed: 0, note: why })),
  ]
  writeFileSync(out, JSON.stringify({ suite: "next", rows }, null, 2))
})

describe("G-2 read-path inventory", () => {
  it("every app/api route module is either a G-2 service module or mapped out of scope", () => {
    const inScope = new Set(Object.keys(MODULES))
    const unmapped = routeModules().filter((r) => !inScope.has(r) && !(r in OUT_OF_SCOPE_MODULES))
    expect(unmapped).toEqual([])
    for (const r of Object.keys(OUT_OF_SCOPE_MODULES)) expect(routeModules()).toContain(r)
  })

  it("every read/act selector discovered in the G-2 service modules is tested or reviewed out of scope, and nothing listed is stale", () => {
    const discovered = Object.keys(MODULES).flatMap(discover).sort()
    const listed = [...READ_PATHS.map(selectorKey), ...Object.keys(OUT_OF_SCOPE_SELECTORS)].sort()
    expect(discovered).toEqual(listed)
  })

  it("each G-2 service has tested read paths or NOT_BUILT entries, and every listed service is one of the five (plus D6-1 reached through D2-1)", () => {
    for (const s of ["D1-1", "D1-2", "D3-1", "D5-1", "D2-1"] as const) {
      expect([s, READ_PATHS.some((p) => p.service === s) || NOT_BUILT.some((n) => n.service === s)]).toEqual([s, true])
    }
  })
})

describe.each(MODES)("G-2 cross-firm isolation, %s persistence", (mode) => {
  let env: RulesTestEnvironment | undefined
  let A: FirmSeed
  let B: FirmSeed

  /** Runs `fn` with this mode's persistence wired (Firestore: an admin context on the emulator). */
  async function inMode<T>(fn: () => Promise<T>): Promise<T> {
    if (mode === "memory") return fn()
    let result!: T
    await env!.withSecurityRulesDisabled(async (ctx) => {
      setFirestorePersistenceForTests(ctx.firestore())
      try {
        result = await fn()
      } finally {
        setFirestorePersistenceForTests(null)
      }
    })
    return result
  }

  beforeAll(async () => {
    vi.stubEnv("SIKANDER_AUTH_MODE", "firebase")
    vi.stubEnv("FIREBASE_PROJECT_ID", "demo-sikander")
    vi.stubEnv("SIKANDER_PERSISTENCE_MODE", mode)
    resetSessionStateForTests()
    resetRuntimeStoreForTests()
    installVerifier()
    if (mode === "firestore") {
      env = await initializeTestEnvironment({
        projectId: "demo-g2-next",
        firestore: { rules: readFileSync(path.join(ROOT, "firestore.rules"), "utf8") },
      })
      await env.clearFirestore()
    }
    await inMode(async () => {
      const store = getRuntimeStore()
      const repos = await getRuntimeRepositories(store)
      for (const u of [...FIRM_A_USERS, ...FIRM_B_USERS]) {
        store.users.set(u.id, u)
        await repos.users.upsert(u)
      }
      A = await seedFirm(FIRM_A, "alpha")
      B = await seedFirm(FIRM_B, "beta")
    })
  }, 120_000)

  afterAll(async () => {
    await env?.cleanup()
    vi.unstubAllEnvs()
    resetSessionStateForTests()
    resetRuntimeStoreForTests()
  })

  it.each(READ_PATHS.map((p) => [selectorKey(p), p] as const))("%s: every firm-B role is denied firm-A data", async (_key, readPath) => {
    await inMode(async () => {
      const markers = firmAMarkers(A)
      const failures: string[] = []

      if (readPath.control) {
        const res = await send(user(readPath.control.as), readPath.control.call(A))
        if (res.status !== 200) failures.push(`control as ${readPath.control.as}: status ${res.status} ${res.text}`)
        else if (!res.text.includes(readPath.control.shows(A))) failures.push(`control as ${readPath.control.as}: firm-A data not shown`)
      }

      let attempts = 0
      let allowed = 0
      for (const caller of FIRM_B_USERS) {
        const attacks = [...spoofs(readPath.base(B)), ...readPath.aimed(A, B)]
        for (const attack of attacks) {
          attempts++
          const res = await send(caller, attack.call)
          // A marker the caller itself sent (an id it aimed at, a query it typed) may be echoed; any other is a leak.
          const sent = JSON.stringify(attack.call)
          const leak = markers.filter((m) => res.text.includes(m) && !sent.includes(m))
          const refused = res.status >= 400 && res.status < 500
          if ((attack.mustDeny && !refused) || leak.length > 0) {
            allowed++
            failures.push(`${caller.id} ${attack.label}: status ${res.status}${leak.length ? `, leaked ${leak.join(",")}` : ""}`)
          }
          if (res.status >= 500) failures.push(`${caller.id} ${attack.label}: server error ${res.status} ${res.text}`)
        }
      }
      coverage.push({
        suite: "next",
        mode,
        service: readPath.service,
        channel: readPath.channel,
        path: selectorKey(readPath),
        status: "tested",
        attempts,
        allowed,
        note: readPath.note,
      })
      expect(failures).toEqual([])
    })
  }, 120_000)

  it("the Idempotency-Key of a firm-A write replays nothing to a firm-B caller", async () => {
    await inMode(async () => {
      const key = randomUUID()
      const aBody = { action: "conflict_check", firmId: FIRM_A, entityId: A.entityId }
      const first = await send(user("partner_a"), { route: "/api/d1/clients", method: "POST", body: aBody, idempotencyKey: key })
      expect(first.status).toBe(200)
      const markers = firmAMarkers(A)
      for (const caller of FIRM_B_USERS) {
        for (const body of [{ action: "conflict_check", firmId: FIRM_B, entityId: B.entityId }, { action: "conflict_check", entityId: A.entityId }]) {
          const res = await send(caller, { route: "/api/d1/clients", method: "POST", body, idempotencyKey: key })
          expect([caller.id, markers.filter((m) => res.text.includes(m))]).toEqual([caller.id, []])
        }
      }
    })
  }, 60_000)
})
