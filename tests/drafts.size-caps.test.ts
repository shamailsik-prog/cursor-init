// SEC-1 (final security audit): a draft body is capped at 500,000 characters and a title at 500,
// checked before the charset check and the citation gate run (422 draft_too_large /
// title_too_long). The audit's route probe — one associate's 22 KB "S.C.M.R." preflight blocked
// the process for 19 s — now answers in well under the 2 s it asked for.
import { afterEach, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { POST as FILINGS } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { composeDraft } from "@/services/d4-1/drafts"
import {
  DraftSizeError,
  MAX_DRAFT_BODY_CHARS,
  MAX_DRAFT_TITLE_CHARS,
  requireSupportedDraftBody,
  requireSupportedDraftTitle,
} from "@/services/d4-2/draftCharset"
import { getDocumentTypes } from "@/lib/foundation-data"

let n = 0
const key = () => `5ec1ca95-0000-4000-8000-${String(++n).padStart(12, "0")}`
const post = (body: unknown) =>
  DRAFTS(
    new Request("http://127.0.0.1/api/d4/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify(body),
    })
  )
const filing = (body: unknown) =>
  FILINGS(
    new Request("http://127.0.0.1/api/d4/filings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify(body),
    })
  )

function setup() {
  const store = getRuntimeStore()
  const matter = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
  addMember(store, matter.id, "associate_a", "firmA")
  return { store, matterId: matter.id }
}

afterEach(() => resetRuntimeStoreForTests())

describe("SEC-1 draft size caps", () => {
  it("the caps are 500,000 characters for a body and 500 for a title", () => {
    expect(MAX_DRAFT_BODY_CHARS).toBe(500_000)
    expect(MAX_DRAFT_TITLE_CHARS).toBe(500)
  })

  it("a body or title at its cap is accepted; one character more is refused", () => {
    expect(requireSupportedDraftBody("a".repeat(MAX_DRAFT_BODY_CHARS))).toHaveLength(MAX_DRAFT_BODY_CHARS)
    expect(() => requireSupportedDraftBody("a".repeat(MAX_DRAFT_BODY_CHARS + 1))).toThrow(DraftSizeError)
    expect(requireSupportedDraftTitle("t".repeat(MAX_DRAFT_TITLE_CHARS))).toHaveLength(MAX_DRAFT_TITLE_CHARS)
    expect(() => requireSupportedDraftTitle("t".repeat(MAX_DRAFT_TITLE_CHARS + 1))).toThrow(DraftSizeError)
  })

  it("preflight with a body over the cap is 422 draft_too_large", async () => {
    const { matterId } = setup()
    const res = await post({ action: "preflight", actorId: "associate_a", matterId, classification: "internal", body: "a".repeat(MAX_DRAFT_BODY_CHARS + 1) })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe("draft_too_large")
  })

  it("compose with a title over the cap is 422 title_too_long, and nothing is stored", async () => {
    const { store, matterId } = setup()
    const res = await post({
      action: "compose",
      actorId: "associate_a",
      matterId,
      templateId: getDocumentTypes()[0]!.id,
      title: "t".repeat(MAX_DRAFT_TITLE_CHARS + 1),
      body: "A short body.",
      classification: "internal",
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe("title_too_long")
    expect(store.drafts.size).toBe(0)
  })

  it("compose with a body over the cap is 422 draft_too_large", async () => {
    const { matterId } = setup()
    const res = await post({
      action: "compose",
      actorId: "associate_a",
      matterId,
      templateId: getDocumentTypes()[0]!.id,
      title: "Plaint",
      body: "b".repeat(MAX_DRAFT_BODY_CHARS + 1),
      classification: "internal",
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe("draft_too_large")
  })

  it("the audit's route probe: a 22 KB 'S.C.M.R.' preflight answers in under 2 s", async () => {
    const { matterId } = setup()
    const started = performance.now()
    const res = await post({ action: "preflight", actorId: "associate_a", matterId, classification: "internal", body: "S.C.M.R. ".repeat(2500) })
    expect(performance.now() - started).toBeLessThan(2000)
    expect(res.status).toBe(200)
  })

  it("approving a filing package re-reads the stored title under the title cap: 501 characters is 422 title_too_long", async () => {
    // R4-2: a client-SDK title edit is allowed on a locked draft, so approval re-checks the
    // stored title. It must be held to the title cap (500), not the body cap (500,000).
    const { store, matterId } = setup()
    addMember(store, matterId, "partner_a", "firmA")
    const draft = composeDraft(store, {
      actorId: "associate_a", matterId, templateId: getDocumentTypes()[0]!.id, title: "Plaint", body: "Clean pleading.",
      classification: "internal",
      preflight: { actorId: "associate_a", matterId, classification: "internal", citedJudgmentIds: [], temporalCitations: [] },
    })
    const created = await filing({ action: "create_package", actorId: "associate_a", matterId, draftId: draft.id, classification: "internal" })
    expect(created.status).toBe(200)
    const pkg = ((await created.json()) as { result: { filingPackage: { id: string } } }).result.filingPackage
    const stored = store.drafts.get(draft.id)!
    store.drafts.set(draft.id, { ...stored, title: "t".repeat(MAX_DRAFT_TITLE_CHARS + 1) })
    const res = await filing({ action: "decide_package", actorId: "partner_a", packageId: pkg.id, decision: "approve", reason: "ok" })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe("title_too_long")
    expect(store.filingPackages.get(pkg.id)?.status).toBe("pending_partner_approval")
  })

  it("approving a filing package with a stored title at the cap succeeds", async () => {
    const { store, matterId } = setup()
    addMember(store, matterId, "partner_a", "firmA")
    const draft = composeDraft(store, {
      actorId: "associate_a", matterId, templateId: getDocumentTypes()[0]!.id, title: "t".repeat(MAX_DRAFT_TITLE_CHARS), body: "Clean pleading.",
      classification: "internal",
      preflight: { actorId: "associate_a", matterId, classification: "internal", citedJudgmentIds: [], temporalCitations: [] },
    })
    const created = await filing({ action: "create_package", actorId: "associate_a", matterId, draftId: draft.id, classification: "internal" })
    expect(created.status).toBe(200)
    const pkg = ((await created.json()) as { result: { filingPackage: { id: string } } }).result.filingPackage
    const res = await filing({ action: "decide_package", actorId: "partner_a", packageId: pkg.id, decision: "approve", reason: "ok" })
    expect(res.status).toBe(200)
  })
})
