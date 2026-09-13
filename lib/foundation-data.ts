import courtsSeed from "@/data/courts.json"
import typesSeed from "@/data/documentTypes.json"
import type { CourtRecord } from "@/core/case-number-normaliser"
import { loadCourts } from "@/core/case-number-normaliser"

export const G0_GUARDS = [
  { id: 1, name: "fee-guard", detail: "No court-fee identifiers in the app tree (E-15). L17.9 REMOVED by E-15 (8 Sep 2026)." },
  { id: 2, name: "scraper-guard", detail: "No Playwright/Puppeteer. No HTTP fetch off the L4.9 legislation allowlist (empty until the firm lists hosts)." },
  { id: 3, name: "provider-guard", detail: "AI / OCR / STT / TTS SDKs only under platform/committeeBrain or platform/p1." },
  { id: 4, name: "duplicate-route", detail: "One owner per namespaced /api/{domain}/{service}/{function} route." },
  { id: 5, name: "phase-0 files", detail: "firestore.rules, courts.json, documentTypes.json, corpus and platform DDL." },
  { id: 6, name: "prefix-fixture-guard", detail: "Every courts.json fixture normalises as expected. SC bare C.P. stays CP + AMBIGUOUS." },
  { id: 7, name: "seed-clone-guard", detail: "159 VERIFIED types, posture present, arrays as arrays, no cloned checklists." },
  { id: 8, name: "embedding-lock", detail: "text-embedding-3-small, 1536 dims, HNSW. Search must refuse on mismatch." },
  { id: 9, name: "classification-guard", detail: "Ranks 0–4. Compare ranks, never label strings. P1 calls carry classification in metadata." },
  { id: 10, name: "firestore coverage", detail: "Every Phase 0 collection has a block. Default deny. No other-firm grant." },
  { id: 11, name: "master-write-guard", detail: "No writes to master tables or master_versions except P6." },
  { id: 12, name: "idempotency-guard", detail: "Every POST/PUT requires Idempotency-Key." },
  { id: 13, name: "pagination-guard", detail: "Every list GET accepts limit and cursor." },
] as const

export const FEATURE_FLAGS = [
  { flag: "CORE_ENABLED", description: "Core spine", defaultEnabled: true, layer: "CORE" },
  { flag: "L17_1_ENABLED", description: "Temporal-law binding", defaultEnabled: true, layer: "L17_1" },
  { flag: "L17_2_ENABLED", description: "Entity resolution", defaultEnabled: true, layer: "L17_2" },
  { flag: "L17_3_ENABLED", description: "Privilege propagation", defaultEnabled: true, layer: "L17_3" },
  { flag: "L17_4_ENABLED", description: "Proposition engine", defaultEnabled: true, layer: "L17_4" },
  { flag: "L17_5_ENABLED", description: "Master-Knowledge single writer", defaultEnabled: true, layer: "L17_5" },
  { flag: "L17_6_ENABLED", description: "Accounts intimation chain", defaultEnabled: true, layer: "L17_6" },
  { flag: "L17_7_ENABLED", description: "Universal authority viewer", defaultEnabled: true, layer: "L17_7" },
  { flag: "L17_8A_ENABLED", description: "Auto-Clerk ambiguity queue", defaultEnabled: true, layer: "L17_8" },
  { flag: "L17_8B_ENABLED", description: "Case-number follow-up", defaultEnabled: true, layer: "L17_8" },
  { flag: "L17_10_ENABLED", description: "Corpus contract", defaultEnabled: true, layer: "L17_10" },
  { flag: "L17_11_ENABLED", description: "Authority integrity", defaultEnabled: true, layer: "L17_11" },
  { flag: "L9_2_BILLING", description: "Subscription invoicing (GATED)", defaultEnabled: false, layer: "L9_2" },
  { flag: "WA_31_CUT", description: "Deferred WhatsApp commands beyond the 8-command grammar", defaultEnabled: false, layer: "D2_1" },
  { flag: "L18_TEMPLATE_EXAMPLE", description: "Amendment-layer template", defaultEnabled: false, layer: "L18_X" },
] as const

export const OPEN_ITEMS = [
  { id: "O-2", title: "R2 signer live test", note: "TODO(firm) — do not invent a signer or bucket." },
  { id: "O-8", title: "Retention period", note: "TODO(firm) — no value invented in DDL." },
  { id: "O-9", title: "Confirm court prefixes against the firm's filings", note: "TODO(firm) — prefixes are data in data/courts.json." },
  { id: "O-10", title: "200/200 entity-resolution pairs", note: "TODO(firm) — evaluation set; do not invent pairs." },
  { id: "O-11", title: "PBC rule numbers", note: "TODO(firm) — do not invent rule numbers." },
  { id: "O-12", title: "Metered cost model at G-1", note: "TODO(firm) — no invented tariffs." },
] as const

export const CLASSIFICATION_RANKS = [
  { label: "public", rank: 0 },
  { label: "internal", rank: 1 },
  { label: "confidential", rank: 2 },
  { label: "privileged", rank: 3 },
  { label: "privileged-restricted", rank: 4 },
] as const

export const FIRESTORE_COLLECTIONS = [
  "firms",
  "users",
  "matter_members",
  "clients",
  "matters",
  "documents",
  "document_versions",
  "entities",
  "entity_aliases",
  "merge_events",
  "evidence_items",
  "custody_events",
  "propositions",
  "drafts",
  "draft_versions",
  "change_proposals",
  "master_versions",
  "routing_queue",
  "follow_ups",
  "intimation_register",
  "notifications",
  "jobs",
  "api_keys",
  "audit_log",
] as const

export type DocumentType = (typeof typesSeed)["types"][number]

export function getCourts(): CourtRecord[] {
  return Object.values(loadCourts(courtsSeed))
}

export function getFixtures() {
  return courtsSeed.fixtures as [string, string, string | null, boolean][]
}

export function getDocumentTypes(): DocumentType[] {
  return typesSeed.types
}
