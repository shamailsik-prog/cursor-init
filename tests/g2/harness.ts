import { randomUUID } from "node:crypto"
import * as clientsRoute from "@/app/api/d1/clients/route"
import * as reportingRoute from "@/app/api/d1/reporting/route"
import * as mattersRoute from "@/app/api/d1/matters/route"
import * as documentsRoute from "@/app/api/d1/documents/route"
import * as workflowRoute from "@/app/api/d1/document-workflow/route"
import * as courtOpsRoute from "@/app/api/d2/court-ops/route"
import * as tenancyRoute from "@/app/api/p5/tenancy/route"
import { CLIENTS_SURFACE } from "@/app/api/d1/clients/surface"
import { REPORTING_SURFACE } from "@/app/api/d1/reporting/surface"
import { MATTERS_SURFACE } from "@/app/api/d1/matters/surface"
import { DOCUMENTS_SURFACE } from "@/app/api/d1/documents/surface"
import { DOCUMENT_WORKFLOW_SURFACE } from "@/app/api/d1/document-workflow/surface"
import { COURT_OPS_SURFACE } from "@/app/api/d2/court-ops/surface"
import { TENANCY_SURFACE } from "@/app/api/p5/tenancy/surface"
import type { RouteSurface } from "@/platform/http/surface"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import type { Role, User } from "@/platform/spine/store"

/**
 * Gate G-2 harness (web side): the two firms, their users and tokens, the
 * request helper over the real route handlers, and the seed that gives both
 * firms the same shape of data through those handlers.
 */

export const FIRM_A = "firmA"
export const FIRM_B = "firmB"
export const ROLES: readonly Role[] = ["partner", "associate", "clerk", "intern", "accounts", "client"]

export const FIRM_A_USERS: User[] = [
  { id: "partner_a", firmId: FIRM_A, role: "partner", clearanceLevel: "privileged-restricted" },
  { id: "associate_a", firmId: FIRM_A, role: "associate", clearanceLevel: "privileged" },
  { id: "clerk_a", firmId: FIRM_A, role: "clerk", clearanceLevel: "confidential" },
  { id: "intern_a", firmId: FIRM_A, role: "intern", clearanceLevel: "internal" },
  { id: "accounts_a", firmId: FIRM_A, role: "accounts", clearanceLevel: "internal" },
  { id: "client_a", firmId: FIRM_A, role: "client", clearanceLevel: "internal" },
]
/** Every firm-B caller holds the top clearance, so only the firm boundary can refuse it. */
export const FIRM_B_USERS: User[] = ROLES.map((role) => ({
  id: `${role}_b`,
  firmId: FIRM_B,
  role,
  clearanceLevel: "privileged-restricted",
}))
export const tokenOf = (uid: string) => `g2-token-${uid}`
export const user = (id: string): User => {
  const u = [...FIRM_A_USERS, ...FIRM_B_USERS].find((x) => x.id === id)
  if (!u) throw new Error(`unknown test user ${id}`)
  return u
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

type Handler = (request: Request) => Promise<Response>
type RouteModule = { GET?: Handler; POST?: Handler }

export type Call = {
  route: string
  method: "GET" | "POST"
  query?: Record<string, string>
  body?: Record<string, unknown>
  /** Overrides the caller's own firm in X-Firm-Id. */
  firmHeader?: string
  idempotencyKey?: string
}

/** The route modules of the G-2 services, keyed by their app/api path. */
export const MODULES: Record<string, RouteModule> = {
  "/api/d1/clients": clientsRoute,
  "/api/d1/reporting": reportingRoute,
  "/api/d1/matters": mattersRoute,
  "/api/d1/documents": documentsRoute,
  "/api/d1/document-workflow": workflowRoute,
  "/api/d2/court-ops": courtOpsRoute,
  "/api/p5/tenancy": tenancyRoute,
}

/** Each G-2 module's declared request surface (its sibling surface.ts). */
export const SURFACES: Record<string, RouteSurface> = {
  "/api/d1/clients": CLIENTS_SURFACE,
  "/api/d1/reporting": REPORTING_SURFACE,
  "/api/d1/matters": MATTERS_SURFACE,
  "/api/d1/documents": DOCUMENTS_SURFACE,
  "/api/d1/document-workflow": DOCUMENT_WORKFLOW_SURFACE,
  "/api/d2/court-ops": COURT_OPS_SURFACE,
  "/api/p5/tenancy": TENANCY_SURFACE,
}

export type Sent = { status: number; body: unknown; text: string }

/** Sends `call` as `caller` (Bearer token + X-Firm-Id). `text` is the response headers and body, as scanned for leaks. */
export async function send(caller: User, call: Call): Promise<Sent> {
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
  const raw = await res.text()
  let body: unknown = raw
  try {
    body = JSON.parse(raw)
  } catch {
    // non-JSON body: kept as text
  }
  return { status: res.status, body, text: `${JSON.stringify([...res.headers])}\n${raw}` }
}

export async function ok<T>(caller: User, call: Call): Promise<T> {
  const res = await send(caller, call)
  if (res.status !== 200) throw new Error(`setup ${call.method} ${call.route} as ${caller.id} → ${res.status} ${res.text}`)
  return res.body as T
}

export const get = (route: string, query: Record<string, string> = {}): Call => ({ route, method: "GET", query })
export const post = (route: string, body: Record<string, unknown>): Call => ({ route, method: "POST", body })

// ---------------------------------------------------------------------------
// P5 tenancy lineage chains
// ---------------------------------------------------------------------------

export const TENANCY = "/api/p5/tenancy"

/** A session-reference lineage: the partner's own session (root) and a diverged reissue of it (child). */
export type Chain = { firmId: string; partnerId: string; root: string; child: string; ext: string; disputeId?: string }

type Step = { action: string; body: (c: Chain) => Record<string, unknown> }

/**
 * The lineage state machine in the order the handlers accept it
 * (tests/api.tenancy.test.ts). A step's action is valid once the steps before
 * it have run on the same root.
 */
export const LINEAGE_STEPS: Step[] = [
  { action: "attest_session_lineage_dispute", body: (c) => ({ sessionReferenceId: c.child, reason: "g2 boundary mismatch" }) },
  { action: "assign_lineage_reconciliation_queue", body: (c) => ({ lineageRootSessionReferenceId: c.root, assignedPartnerId: c.partnerId, slaWindowMinutes: 90 }) },
  { action: "arbitrate_lineage_reconciliation_queue", body: (c) => ({ lineageRootSessionReferenceId: c.root, disposition: "confirm_needs_review" }) },
  { action: "attest_lineage_digest_closure", body: (c) => ({ lineageRootSessionReferenceId: c.root, closureReason: "g2 closure" }) },
  { action: "reopen_lineage_digest_closure", body: (c) => ({ lineageRootSessionReferenceId: c.root, reopenTrigger: "g2 reopen" }) },
  { action: "govern_lineage_closure_adjudication", body: (c) => ({ lineageRootSessionReferenceId: c.root, panelPartnerIds: [c.partnerId], requiredPanelQuorum: 1, verdictWindowMinutes: 60 }) },
  { action: "record_lineage_closure_adjudication_verdict", body: (c) => ({ lineageRootSessionReferenceId: c.root, disposition: "mark_reconciled", dispositionDriftReasons: ["panel_alignment_confirmed"] }) },
  { action: "attest_lineage_arbitration_debt_retirement", body: (c) => ({ lineageRootSessionReferenceId: c.root, retirementNote: "g2 retired" }) },
  { action: "reopen_lineage_arbitration_debt_retirement", body: (c) => ({ lineageRootSessionReferenceId: c.root, carryoverSignal: "g2 carryover" }) },
  { action: "checkpoint_lineage_closure_adjudication_settlement_publication", body: (c) => ({ lineageRootSessionReferenceId: c.root, publicationChannel: "partner_workboard" }) },
  { action: "log_lineage_closure_adjudication_settlement_correction", body: (c) => ({ lineageRootSessionReferenceId: c.root, correctionNote: "g2 correction" }) },
  { action: "confirm_lineage_closure_adjudication_settlement_sla", body: (c) => ({ lineageRootSessionReferenceId: c.root }) },
  { action: "open_lineage_arbitration_debt_retirement_dispute", body: (c) => ({ lineageRootSessionReferenceId: c.root, challengeReason: "g2 challenge" }) },
  { action: "assign_lineage_arbitration_debt_retirement_dispute_reviewer", body: (c) => ({ lineageRootSessionReferenceId: c.root, reviewerId: c.partnerId }) },
  { action: "resolve_lineage_arbitration_debt_retirement_dispute", body: (c) => ({ lineageRootSessionReferenceId: c.root, resolutionOutcome: "require_rollback_review", resolutionNote: "g2 resolved" }) },
  { action: "control_lineage_arbitration_debt_retirement_dispute_rollback", body: (c) => ({ lineageRootSessionReferenceId: c.root, rollbackControlNote: "g2 rollback" }) },
  { action: "resolve_session_lineage_dispute", body: (c) => ({ disputeId: c.disputeId, disposition: "mark_reconciled", resolutionNote: "g2 reconciled" }) },
]

/** The external-session identity bridge on a chain's child: attest, attest a mismatch, quarantine, clear. */
export const BRIDGE_STEPS: Step[] = [
  { action: "attest_external_session_identity_bridge", body: (c) => ({ sessionReferenceId: c.child, assertedIssuer: "idp.sandbox.local", assertedSubject: `${c.partnerId}:g2`, assertedExternalSessionId: c.ext }) },
  { action: "attest_external_session_identity_bridge", body: (c) => ({ sessionReferenceId: c.child, assertedIssuer: "idp.sandbox.local", assertedSubject: `${c.partnerId}:g2`, assertedExternalSessionId: `${c.ext}-mismatch` }) },
  { action: "quarantine_external_session_identity_bridge", body: (c) => ({ sessionReferenceId: c.child, quarantineReason: "g2 issuer drift" }) },
  { action: "clear_external_session_identity_bridge", body: (c) => ({ sessionReferenceId: c.child, clearReason: "g2 verified" }) },
]

export function stepCall(c: Chain, step: Step): Call {
  return post(TENANCY, { action: step.action, firmId: c.firmId, ...step.body(c) })
}

/** A fresh chain in `firmId`, advanced through the first `k` of `steps` by the firm's partner. */
export async function chainAt(firmId: string, steps: Step[] = [], k = 0): Promise<Chain> {
  const partner = user(firmId === FIRM_A ? "partner_a" : "partner_b")
  const session = await ok<{ sessionReference: { id: string } }>(partner, get(TENANCY, { view: "session" }))
  const ext = `ext-${randomUUID().slice(0, 8)}`
  const reissued = await ok<{ result: { sessionReference: { id: string } } }>(
    partner,
    post(TENANCY, {
      action: "reissue_session_reference",
      firmId,
      sessionReferenceId: session.sessionReference.id,
      authBoundary: "external_session_hint",
      externalSessionId: ext,
    })
  )
  const chain: Chain = { firmId, partnerId: partner.id, root: session.sessionReference.id, child: reissued.result.sessionReference.id, ext }
  for (const step of steps.slice(0, k)) {
    const res = await ok<{ result: { dispute?: { id: string } } }>(partner, stepCall(chain, step))
    if (step.action === "attest_session_lineage_dispute") chain.disputeId = res.result.dispute?.id
  }
  return chain
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export type FirmSeed = {
  firmId: string
  entityId: string
  entityName: string
  cnic: string
  /** A second firm-A client's CNIC, for the same-person-in-both-firms attack; the one CNIC that is not a leak marker. */
  twinCnic: string
  phone: string
  matterId: string
  matterTitle: string
  titleTerm: string
  docIds: string[]
  contentHashes: string[]
  reviewDocId: string
  bytes: string
  /** A lineage chain run through every lineage and bridge step. */
  tenancy: Chain
}

export async function seedFirm(firmId: string, tag: "alpha" | "beta"): Promise<FirmSeed> {
  const s = firmId === FIRM_A ? "a" : "b"
  const partner = user(`partner_${s}`)
  const titleTerm = `g2${tag}${randomUUID().slice(0, 6)}`
  const entityName = `${tag.toUpperCase()}-Client-${titleTerm}`
  const cnic = firmId === FIRM_A ? "4210111111111" : "3520222222222"
  const phone = firmId === FIRM_A ? "+923001110001" : "+923009990009"
  const twinCnic = firmId === FIRM_A ? "4210177777777" : "3520288888888"
  const client = await ok<{ result: { entity: { id: string } } }>(
    partner,
    post("/api/d1/clients", { action: "create", firmId, canonicalName: entityName, cnic, phone, classification: "confidential" })
  )
  await ok(partner, post("/api/d1/clients", { action: "create", firmId, canonicalName: `${tag.toUpperCase()}-Twin-${titleTerm}`, cnic: twinCnic, phone, classification: "internal" }))
  const matterTitle = `${titleTerm} constitutional petition`
  const matter = await ok<{ result: { matter: { id: string } } }>(
    partner,
    post("/api/d1/matters", {
      action: "create",
      firmId,
      clientId: `client_${s}`,
      title: matterTitle,
      courtId: "SHC",
      classification: "confidential",
      memberUserIds: [`associate_${s}`, `clerk_${s}`, `intern_${s}`],
    })
  )
  const matterId = matter.result.matter.id
  const bytes = `G2 ${tag} privileged brief ${titleTerm}`
  const docIds: string[] = []
  const contentHashes: string[] = []
  for (const [i, m] of [matterId, null, matterId].entries()) {
    const doc = await ok<{ result: { doc: { id: string; contentHash: string } } }>(
      partner,
      post("/api/d1/documents", {
        action: "ingest",
        firmId,
        matterId: m,
        contentBase64: Buffer.from(`${bytes} #${i}`).toString("base64"),
        sourceChannel: "web",
        classification: "confidential",
      })
    )
    docIds.push(doc.result.doc.id)
    contentHashes.push(doc.result.doc.contentHash)
  }
  const reviewDocId = docIds[2]
  // A workflow event on the matter (timeline) and a review blocker (court-ops / WhatsApp /ops queue).
  await ok(partner, post("/api/d1/document-workflow", { action: "transition", documentId: reviewDocId, nextStatus: "review_required", reason: `${tag} review` }))
  await ok(partner, post("/api/d1/reporting", { action: "record_matter_report_export", matterId, exportFormat: "pdf", exportScope: "summary" }))
  const tenancy = await chainAt(firmId, LINEAGE_STEPS, LINEAGE_STEPS.length)
  for (const step of BRIDGE_STEPS) await ok(partner, stepCall(tenancy, step))
  return { firmId, entityId: client.result.entity.id, entityName, cnic, twinCnic, phone, matterId, matterTitle, titleTerm, docIds, contentHashes, reviewDocId, bytes, tenancy }
}

/** Placeholder seeds: lets the inventory evaluate attack shapes without seeding. */
export function placeholderSeed(firmId: string): FirmSeed {
  const id = (k: string) => `${firmId}-${k}`
  return {
    firmId,
    entityId: id("entity"),
    entityName: id("name"),
    cnic: "0000000000000",
    twinCnic: "0000000000001",
    phone: "+920000000000",
    matterId: id("matter"),
    matterTitle: id("title"),
    titleTerm: id("term"),
    docIds: [id("d0"), id("d1"), id("d2")],
    contentHashes: [id("h0"), id("h1"), id("h2")],
    reviewDocId: id("d2"),
    bytes: id("bytes"),
    tenancy: { firmId, partnerId: id("partner"), root: id("root"), child: id("child"), ext: id("ext"), disputeId: id("dispute") },
  }
}

const MARKER_KEYS = [
  "id",
  "documentId",
  "matterId",
  "entityId",
  "clientId",
  "contentHash",
  "sessionReferenceId",
  "lineageRootSessionReferenceId",
  "parentSessionReferenceId",
  "digestId",
]

/**
 * Every identifier of firm `firmId` held in the runtime store (users, matters,
 * documents, jobs, workflow rows and events, reporting rows, tenancy rows, ...):
 * any row with `firmId` contributes its id-like fields. Plus the seed's names
 * and phone.
 * Derived from the store, so a new row type is covered without listing it.
 */
export function firmMarkers(seed: FirmSeed): string[] {
  // Not twinCnic (the D1-1 attack registers that person with firm B too) and not
  // externalSessionId (a caller-supplied hint: the gate itself sends firm A's value
  // as firm B, which stores it on firm B's own session reference).
  const out = new Set<string>([seed.firmId, seed.entityName, seed.cnic, seed.phone, seed.titleTerm])
  const visit = (row: unknown) => {
    if (!row || typeof row !== "object") return
    const r = row as Record<string, unknown>
    if (r.firmId !== seed.firmId) return
    for (const k of MARKER_KEYS) {
      const v = r[k]
      if (typeof v === "string" && v.length >= 6) out.add(v)
    }
  }
  for (const value of Object.values(getRuntimeStore() as unknown as Record<string, unknown>)) {
    if (value instanceof Map) for (const row of value.values()) visit(row)
    else if (Array.isArray(value)) for (const row of value) visit(row)
  }
  return [...out]
}
