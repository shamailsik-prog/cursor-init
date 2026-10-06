import { randomUUID } from "node:crypto"
import type { User } from "@/platform/spine/store"
import {
  BRIDGE_STEPS,
  FIRM_A,
  FIRM_B,
  LINEAGE_STEPS,
  TENANCY,
  chainAt,
  get,
  ok,
  post,
  stepCall,
  user,
  type Call,
  type Chain,
  type FirmSeed,
} from "./harness"

/**
 * Gate G-2 read paths (web side): every read and data-returning action of
 * D1-1, D1-2, D3-1, D5-1 and D2-1 (plus D6-1 reached through D2-1) and the
 * P5 tenancy views and actions (L18 R-5 / line 76: "live cross-tenant test
 * on P5"), with how a firm-B caller uses each legitimately (`base`) and how
 * it is aimed at firm A (`aimed`).
 */

export type Service = "D1-1" | "D1-2" | "D3-1" | "D5-1" | "D2-1" | "D6-1" | "P5"
export type Channel = "web" | "whatsapp"

/** What a refusal of a firm-A object must say: a tenant-scoped lookup or a firm check, never a validation error. */
export const TENANT_DENY = /cross-firm|firm scope|unknown|not found|not permitted|not a member|denied/i

export type Attack = { label: string; call: Call; mustDeny: boolean; expect?: RegExp }

export type BaseCtx = {
  caller: User
  A: FirmSeed
  B: FirmSeed
  /** Memoised setup, rebuilt after any base request succeeded (so each successful base runs on fresh state). */
  fresh: <T>(key: string, build: () => Promise<T>) => Promise<T>
}

export type ReadPath = {
  service: Service
  channel: Channel
  route: string
  method: "GET" | "POST"
  /** "list", "view=<v>", "action=<a>" or "command=/<c>". */
  selector: string
  /** "read": returns tenant data; "write": mutates, and its response echoes the record. */
  kind: "read" | "write"
  note?: string
  /** Query params that name a subject (a filter), not the caller; they get no identity spoof. */
  subjectParams?: string[]
  /** A firm-B caller's own-scope request; it must succeed for at least one firm-B role. Spoofs are derived from it. */
  base: (ctx: BaseCtx) => Call | Promise<Call>
  /** Requests aimed at firm-A objects (by id / by filter). Pure in the seeds (the inventory evaluates them). */
  aimed: (a: FirmSeed, b: FirmSeed) => Attack[]
  /** A firm-A request that must return 200 and show firm-A data (`shows`, default the firm id). */
  control?: { as: string; call: (a: FirmSeed) => Call | Promise<Call>; shows?: (a: FirmSeed) => string }
}

const deny = (label: string, call: Call, expect: RegExp = TENANT_DENY): Attack => ({ label, call, mustDeny: true, expect })
const filter = (label: string, call: Call): Attack => ({ label, call, mustDeny: false })
const WA = (command: string) => post("/api/d2/court-ops", { action: "whatsapp_command", command })

/** A firm-B loose-vault document (no matter), so every staff role may act on it. */
async function looseDocB(): Promise<string> {
  const res = await ok<{ result: { doc: { id: string } } }>(
    user("partner_b"),
    post("/api/d1/documents", {
      action: "ingest",
      firmId: FIRM_B,
      matterId: null,
      contentBase64: Buffer.from(`beta loose ${randomUUID()}`).toString("base64"),
      sourceChannel: "web",
      classification: "internal",
    })
  )
  return res.result.doc.id
}

/** Firm A's fully-run chain, re-addressed to the firm-B caller's own firm: only the ids are firm A's. */
const aimChain = (a: FirmSeed): Chain => ({ ...a.tenancy, firmId: FIRM_B, partnerId: "partner_b" })

const D1_D3_D2_PATHS: ReadPath[] = [
  // D1-1 Client Service (Module 1 client file; Module 43 client reporting)
  {
    service: "D1-1", channel: "web", route: "/api/d1/clients", method: "GET", selector: "list", kind: "read",
    base: () => get("/api/d1/clients", { limit: "100" }),
    aimed: () => [filter("cursor past firm B", get("/api/d1/clients", { limit: "100", cursor: "1" }))],
    control: { as: "partner_a", call: () => get("/api/d1/clients", { limit: "100" }), shows: (a) => a.entityId },
  },
  {
    service: "D1-1", channel: "web", route: "/api/d1/clients", method: "POST", selector: "action=conflict_check", kind: "read",
    base: ({ B }) => post("/api/d1/clients", { action: "conflict_check", firmId: FIRM_B, entityId: B.entityId }),
    aimed: (a) => [deny("firm-A entityId", post("/api/d1/clients", { action: "conflict_check", firmId: FIRM_B, entityId: a.entityId }))],
    control: { as: "partner_a", call: (a) => post("/api/d1/clients", { action: "conflict_check", firmId: FIRM_A, entityId: a.entityId }), shows: (a) => a.entityId },
  },
  {
    service: "D1-1", channel: "web", route: "/api/d1/clients", method: "POST", selector: "action=create", kind: "write",
    base: () => post("/api/d1/clients", { action: "create", firmId: FIRM_B, canonicalName: `Beta Probe ${randomUUID().slice(0, 6)}`, cnic: "3520233333333", phone: "+923005550000", classification: "internal" }),
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
    base: ({ B }) => post("/api/d1/reporting", { action: "record_matter_report_export", matterId: B.matterId, exportFormat: "csv", exportScope: "summary" }),
    aimed: (a) => [deny("firm-A matterId", post("/api/d1/reporting", { action: "record_matter_report_export", matterId: a.matterId, exportFormat: "csv", exportScope: "summary" }))],
    control: { as: "partner_a", call: (a) => post("/api/d1/reporting", { action: "record_matter_report_export", matterId: a.matterId, exportFormat: "json", exportScope: "detailed" }), shows: (a) => a.matterId },
  },
  {
    service: "D1-1", channel: "web", route: "/api/d1/reporting", method: "POST", selector: "action=recompute_matter_report_relevance", kind: "write",
    base: ({ B }) => post("/api/d1/reporting", { action: "recompute_matter_report_relevance", matterId: B.matterId }),
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
    base: ({ B }) => post("/api/d1/matters", { action: "confirm_engagement", matterId: B.matterId }),
    aimed: (a) => [deny("firm-A matterId", post("/api/d1/matters", { action: "confirm_engagement", matterId: a.matterId }))],
    control: { as: "partner_a", call: (a) => post("/api/d1/matters", { action: "confirm_engagement", matterId: a.matterId }), shows: (a) => a.matterTitle },
  },
  {
    service: "D1-2", channel: "web", route: "/api/d1/matters", method: "POST", selector: "action=record_case_number", kind: "write",
    base: ({ B }) => post("/api/d1/matters", { action: "record_case_number", matterId: B.matterId, raw: "C.P. 1/2026", courtId: "SHC" }),
    aimed: (a) => [deny("firm-A matterId", post("/api/d1/matters", { action: "record_case_number", matterId: a.matterId, raw: "C.P. 1/2026", courtId: "SHC" }))],
    control: { as: "partner_a", call: (a) => post("/api/d1/matters", { action: "record_case_number", matterId: a.matterId, raw: "C.P. 2/2026", courtId: "SHC" }), shows: (a) => a.matterTitle },
  },
  {
    service: "D1-2", channel: "web", route: "/api/d1/matters", method: "POST", selector: "action=create", kind: "write",
    base: () => post("/api/d1/matters", { action: "create", firmId: FIRM_B, clientId: "client_b", title: `Beta probe matter ${randomUUID().slice(0, 6)}`, courtId: "SHC", classification: "internal" }),
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
    base: ({ B }) => get("/api/d1/document-workflow", { view: "timeline", matterId: B.matterId }),
    aimed: (a) => [deny("firm-A matterId", get("/api/d1/document-workflow", { view: "timeline", matterId: a.matterId }))],
    control: { as: "partner_a", call: (a) => get("/api/d1/document-workflow", { view: "timeline", matterId: a.matterId }), shows: (a) => a.reviewDocId },
  },
  {
    service: "D3-1", channel: "web", route: "/api/d1/document-workflow", method: "POST", selector: "action=transition", kind: "write",
    base: async ({ fresh }) => post("/api/d1/document-workflow", { action: "transition", documentId: await fresh("doc", looseDocB), nextStatus: "processing" }),
    aimed: (a) => a.docIds.map((id, i) => deny(`firm-A document #${i}`, post("/api/d1/document-workflow", { action: "transition", documentId: id, nextStatus: "processing" }))),
    control: { as: "partner_a", call: (a) => post("/api/d1/document-workflow", { action: "transition", documentId: a.docIds[1], nextStatus: "processing" }), shows: (a) => a.docIds[1] },
  },
  {
    service: "D3-1", channel: "web", route: "/api/d1/document-workflow", method: "POST", selector: "action=assign_reviewer", kind: "write",
    base: async ({ fresh }) => post("/api/d1/document-workflow", { action: "assign_reviewer", documentId: await fresh("doc", looseDocB), reviewerId: "clerk_b" }),
    aimed: (a, b) => [
      deny("firm-A document", post("/api/d1/document-workflow", { action: "assign_reviewer", documentId: a.docIds[0], reviewerId: "clerk_b" })),
      deny("firm-A reviewer on a firm-B document", post("/api/d1/document-workflow", { action: "assign_reviewer", documentId: b.docIds[1], reviewerId: "clerk_a" })),
    ],
    control: { as: "partner_a", call: (a) => post("/api/d1/document-workflow", { action: "assign_reviewer", documentId: a.docIds[0], reviewerId: "clerk_a" }), shows: (a) => a.docIds[0] },
  },
  {
    service: "D3-1", channel: "web", route: "/api/d1/document-workflow", method: "POST", selector: "action=review_decision", kind: "write",
    base: async ({ fresh }) => {
      const doc = await fresh("doc-in-review", async () => {
        const id = await looseDocB()
        await ok(user("partner_b"), post("/api/d1/document-workflow", { action: "assign_reviewer", documentId: id, reviewerId: "clerk_b" }))
        return id
      })
      return post("/api/d1/document-workflow", { action: "review_decision", documentId: doc, decision: "confirm_classification" })
    },
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

// ---------------------------------------------------------------------------
// P5 tenancy (users, memberships, audit, session references and lineage)
// ---------------------------------------------------------------------------

/** Lineage list views, the status filter value each accepts, and any extra filter. */
const LINEAGE_VIEWS: Array<[string, Record<string, string>]> = [
  ["session_lineage", { delegatedDivergedOnly: "true" }],
  ["session_lineage_disputes", { status: "open" }],
  ["session_lineage_reconciliation_digests", { status: "needs_review" }],
  ["session_lineage_reconciliation_queue", { status: "queued" }],
  ["session_lineage_digest_closure_checkpoints", { status: "pending_attestation" }],
  ["session_lineage_closure_adjudications", { status: "standby" }],
  ["session_lineage_arbitration_debt_retirement_ledgers", { status: "pressure_open" }],
  ["session_lineage_closure_adjudication_settlements", { status: "draft" }],
  ["session_lineage_arbitration_debt_retirement_dispute_ledgers", { status: "open" }],
  ["session_external_session_identity_bridges", { status: "attested", mismatchStatus: "aligned" }],
]

/** session_lineage lists one lineage, so it needs a root; the other lineage views list the firm's rows. */
const rootOf = (view: string, seed: FirmSeed): Record<string, string> =>
  view === "session_lineage" ? { rootSessionRefId: seed.tenancy.root } : {}

const tenancyView = (view: string, extra: Record<string, string> = {}): ReadPath => ({
  service: "P5", channel: "web", route: TENANCY, method: "GET", selector: `view=${view}`, kind: "read",
  base: ({ B }) => get(TENANCY, { view, firmId: FIRM_B, limit: "100", ...rootOf(view, B) }),
  aimed: (a, b) => [
    filter("rootSessionRefId=firm-A root", get(TENANCY, { view, firmId: FIRM_B, rootSessionRefId: a.tenancy.root })),
    filter("filters", get(TENANCY, { view, firmId: FIRM_B, ...extra, ...rootOf(view, b) })),
  ],
  control: { as: "partner_a", call: (a) => get(TENANCY, { view, firmId: FIRM_A, limit: "100", ...rootOf(view, a) }) },
})

const lineageAction = (steps: typeof LINEAGE_STEPS, k: number, key: string): ReadPath => ({
  service: "P5", channel: "web", route: TENANCY, method: "POST", selector: `action=${steps[k].action}`, kind: "write",
  base: async ({ fresh }) => stepCall(await fresh(key, () => chainAt(FIRM_B, steps, k)), steps[k]),
  aimed: (a) => [deny("firm-A lineage", stepCall(aimChain(a), steps[k]))],
  control: { as: "partner_a", call: async () => stepCall(await chainAt(FIRM_A, steps, k), steps[k]) },
})

const TENANCY_PATHS: ReadPath[] = [
  {
    service: "P5", channel: "web", route: TENANCY, method: "GET", selector: "view=session", kind: "read",
    note: "the caller's own session; also mints a session reference",
    base: () => get(TENANCY, { view: "session" }),
    aimed: (a) => [
      deny("sessionRefId = firm-A session reference", get(TENANCY, { view: "session", sessionRefId: a.tenancy.child })),
      deny("sessionRefId = firm-A root", get(TENANCY, { view: "session", sessionRefId: a.tenancy.root })),
      filter("externalSessionId of firm A", get(TENANCY, { view: "session", authBoundary: "external_session_hint", externalSessionId: a.tenancy.ext })),
    ],
    control: { as: "partner_a", call: () => get(TENANCY, { view: "session" }) },
  },
  {
    service: "P5", channel: "web", route: TENANCY, method: "GET", selector: "view=users", kind: "read",
    base: () => get(TENANCY, { view: "users", firmId: FIRM_B, limit: "100" }),
    aimed: () => [],
    control: { as: "partner_a", call: () => get(TENANCY, { view: "users", firmId: FIRM_A, limit: "100" }), shows: () => "clerk_a" },
  },
  {
    service: "P5", channel: "web", route: TENANCY, method: "GET", selector: "view=memberships", kind: "read",
    base: () => get(TENANCY, { view: "memberships", firmId: FIRM_B, limit: "100" }),
    aimed: (a) => [filter("matterId=firm-A matter", get(TENANCY, { view: "memberships", firmId: FIRM_B, matterId: a.matterId }))],
    control: { as: "partner_a", call: () => get(TENANCY, { view: "memberships", firmId: FIRM_A, limit: "100" }), shows: (a) => a.matterId },
  },
  {
    service: "P5", channel: "web", route: TENANCY, method: "GET", selector: "view=audit", kind: "read",
    base: () => get(TENANCY, { view: "audit", firmId: FIRM_B, limit: "100" }),
    aimed: () => [],
    control: { as: "partner_a", call: () => get(TENANCY, { view: "audit", firmId: FIRM_A, limit: "100" }), shows: (a) => a.matterId },
  },
  {
    service: "P5", channel: "web", route: TENANCY, method: "GET", selector: "view=session_refs", kind: "read",
    subjectParams: ["userId"],
    base: () => get(TENANCY, { view: "session_refs", firmId: FIRM_B, limit: "100" }),
    aimed: () => [
      filter("userId=firm-A partner", get(TENANCY, { view: "session_refs", firmId: FIRM_B, userId: "partner_a" })),
      filter("userId=firm-A clerk", get(TENANCY, { view: "session_refs", firmId: FIRM_B, userId: "clerk_a" })),
    ],
    control: { as: "partner_a", call: () => get(TENANCY, { view: "session_refs", firmId: FIRM_A, limit: "100" }), shows: (a) => a.tenancy.root },
  },
  ...LINEAGE_VIEWS.map(([view, extra]) => tenancyView(view, extra)),
  {
    service: "P5", channel: "web", route: TENANCY, method: "POST", selector: "action=update_role", kind: "write",
    base: () => post(TENANCY, { action: "update_role", firmId: FIRM_B, targetUserId: "accounts_b", nextRole: "accounts", nextClearance: "privileged-restricted", reason: "g2 base" }),
    aimed: () => [
      deny("firm-A target user", post(TENANCY, { action: "update_role", firmId: FIRM_B, targetUserId: "clerk_a", nextRole: "clerk", nextClearance: "confidential", reason: "g2 aimed" })),
    ],
    control: { as: "partner_a", call: () => post(TENANCY, { action: "update_role", firmId: FIRM_A, targetUserId: "accounts_a", nextRole: "accounts", nextClearance: "internal", reason: "g2 control" }) },
  },
  {
    service: "P5", channel: "web", route: TENANCY, method: "POST", selector: "action=revoke_session_reference", kind: "write",
    base: async ({ fresh }) => {
      const c = await fresh("chain", () => chainAt(FIRM_B))
      return post(TENANCY, { action: "revoke_session_reference", firmId: FIRM_B, sessionReferenceId: c.child, reason: "g2 base" })
    },
    aimed: (a) => [deny("firm-A session reference", post(TENANCY, { action: "revoke_session_reference", firmId: FIRM_B, sessionReferenceId: a.tenancy.child, reason: "g2 aimed" }))],
    control: { as: "partner_a", call: async () => post(TENANCY, { action: "revoke_session_reference", firmId: FIRM_A, sessionReferenceId: (await chainAt(FIRM_A)).child, reason: "g2 control" }) },
  },
  {
    service: "P5", channel: "web", route: TENANCY, method: "POST", selector: "action=reissue_session_reference", kind: "write",
    base: async ({ fresh }) => {
      const c = await fresh("chain", () => chainAt(FIRM_B))
      return post(TENANCY, { action: "reissue_session_reference", firmId: FIRM_B, sessionReferenceId: c.root })
    },
    aimed: (a) => [deny("firm-A session reference", post(TENANCY, { action: "reissue_session_reference", firmId: FIRM_B, sessionReferenceId: a.tenancy.root }))],
    control: { as: "partner_a", call: async () => post(TENANCY, { action: "reissue_session_reference", firmId: FIRM_A, sessionReferenceId: (await chainAt(FIRM_A)).root }) },
  },
  ...LINEAGE_STEPS.map((_, k) => lineageAction(LINEAGE_STEPS, k, "lineage")),
  // Bridge steps 0 and 1 are the same action (attest, then attest a mismatch): one path for it.
  ...[0, 2, 3].map((k) => lineageAction(BRIDGE_STEPS, k, "bridge")),
]

export const READ_PATHS: ReadPath[] = [...D1_D3_D2_PATHS, ...TENANCY_PATHS]

export const selectorKey = (p: { method: string; route: string; selector: string }) => `${p.method} ${p.route} ${p.selector}`

/** Selectors of G-2 service modules that are writes with no firm-A read surface, reviewed and outside the read set. */
export const OUT_OF_SCOPE_SELECTORS: Record<string, string> = {
  "POST /api/d2/court-ops action=acknowledge_item": "D6-1 court-ops write",
  "POST /api/d2/court-ops action=resolve_follow_up": "D6-1 court-ops write",
  "POST /api/d2/court-ops action=resolve_workflow": "D6-1 court-ops write",
}

/** Route modules outside the G-2 services and P5 (not part of the G-2 read set). */
export const OUT_OF_SCOPE_MODULES: Record<string, string> = {
  "/api/d2/ops-reporting": "D2-3 web ops reporting",
  "/api/d4/drafts": "D4-1 drafting factory",
  "/api/d4/filings": "D4-3 filing packages",
  "/api/p1/committee-brain": "P1 AI gateway",
  "/api/g0/monitor": "G-0 public health (no tenant data)",
  "/api/g0/normalise": "G-0 case-number normaliser (no tenant data)",
}

/**
 * Query params of the G-2 modules that are not attacked, reviewed: each one
 * selects the shape of a page or the read path itself, never a tenant.
 * Every other param a G-2 module reads must appear in an attack (aimed, or the
 * firmId / actorId / userId spoofs) or the inventory fails.
 */
export const NON_SELECTOR_PARAMS: Record<string, string> = {
  view: "selects the read path; every value is inventoried as its own selector",
  limit: "page size (clamped 1-100)",
  cursor: "page offset into a list already scoped to the caller",
}

/** Spec read functions of the G-2 services (L18 §3 service table, §8 WhatsApp grammar) with no code yet. */
export const NOT_BUILT: Array<{ service: Service; channel: Channel; path: string; note: string }> = [
  { service: "D1-1", channel: "web", path: "/api/d1/client/* read by id (client file)", note: "only list + conflict_check exist" },
  { service: "D1-2", channel: "web", path: "/api/d1/matter/* read by id; relevant_law_dates (L17.1); entity resolution views (L17.2)", note: "only list exists" },
  { service: "D3-1", channel: "web", path: "/api/d3/vault/* document read/download by id, versions, exports, share links, Ghost Archive, loose vault view", note: "document_versions has rules but no read route" },
  { service: "D5-1", channel: "web", path: "/api/d5/research/* search, arguments, compendium, precedent discovery, authority viewer", note: "services/d5-1 searchCorpus is not routed" },
  { service: "D2-1", channel: "whatsapp", path: "/api/d2/whatsapp/* inbound webhook with phone-number to user binding", note: "commands run as an authenticated session via /api/d2/court-ops; re-run G-2 when the webhook lands" },
  { service: "D2-1", channel: "whatsapp", path: "/matters <Query|CaseRef>", note: "grammar accepts bare /matters only" },
  { service: "D2-1", channel: "whatsapp", path: "/hearings [Date]", note: "not in the command grammar" },
  { service: "D2-1", channel: "whatsapp", path: "/clients [Query]", note: "not in the command grammar" },
  { service: "D2-1", channel: "whatsapp", path: "/drafts [CaseRef]", note: "not in the command grammar" },
  { service: "D2-1", channel: "whatsapp", path: "open N (numbered-list reply)", note: "not in the command grammar" },
]
