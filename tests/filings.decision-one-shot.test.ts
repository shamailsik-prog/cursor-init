// Final audit F2: a filing package decision is one-shot. Approve/reject apply only while the
// durable package is still pending_partner_approval (a conditional update); any later or
// concurrent decision is refused 409 package_already_decided, and the draft lock follows the
// winning decision only.
import { afterEach, describe, expect, it } from "vitest"
import { POST as FILINGS } from "@/app/api/d4/filings/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { composeDraft } from "@/services/d4-1/drafts"
import { getDocumentTypes } from "@/lib/foundation-data"
import { createMemoryRepositories } from "@/platform/persistence/spineRepositories"
import { newStore, type FilingPackage } from "@/platform/spine/store"

afterEach(() => resetRuntimeStoreForTests())

let n = 0
const key = () => `f2f2f2f2-0000-4000-8000-${String(++n).padStart(12, "0")}`
const post = (body: unknown) =>
  FILINGS(
    new Request("http://127.0.0.1/api/d4/filings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key() },
      body: JSON.stringify(body),
    })
  )

async function pendingPackage() {
  const store = getRuntimeStore()
  store.users.set("partner_c", { id: "partner_c", firmId: "firmA", role: "partner", clearanceLevel: "privileged-restricted" })
  const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
  for (const u of ["partner_a", "partner_c", "associate_a"]) addMember(store, m.id, u, "firmA")
  const draft = composeDraft(store, {
    actorId: "associate_a",
    matterId: m.id,
    templateId: getDocumentTypes()[0]!.id,
    title: "d",
    body: "Clean pleading.",
    classification: "internal",
    preflight: { actorId: "associate_a", matterId: m.id, classification: "internal", citedJudgmentIds: [], temporalCitations: [] },
  })
  const res = await post({ action: "create_package", actorId: "associate_a", matterId: m.id, draftId: draft.id, classification: "internal" })
  expect(res.status).toBe(200)
  const pkg = ((await res.json()) as { result: { filingPackage: { id: string } } }).result.filingPackage
  return { store, pkgId: pkg.id, draftId: draft.id }
}

const decide = (actorId: string, packageId: string, decision: "approve" | "reject", reason: string) =>
  post({ action: "decide_package", actorId, packageId, decision, reason })

describe("filing package decision is one-shot (final audit F2)", () => {
  it("concurrent approve and reject: exactly one wins, the other gets 409 package_already_decided", async () => {
    const { store, pkgId, draftId } = await pendingPackage()
    const [a, b] = await Promise.all([decide("partner_a", pkgId, "approve", "ok"), decide("partner_c", pkgId, "reject", "no")])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([200, 409])
    const loser = a.status === 409 ? a : b
    expect(((await loser.json()) as { error: { code: string } | string; code?: string })).toMatchObject({
      code: "package_already_decided",
    })
    const final = store.filingPackages.get(pkgId)!
    const winnerApproved = a.status === 200
    expect(final.status).toBe(winnerApproved ? "approved" : "rejected")
    expect(final.approvedBy).toBe(winnerApproved ? "partner_a" : "partner_c")
    // the lock follows the winning decision only
    expect(store.drafts.get(draftId)?.locked).toBe(winnerApproved)
    const decisionRows = store.audit.filter(
      (r) => r.target === pkgId && (r.action === "filing_package_approve" || r.action === "filing_package_reject")
    )
    expect(decisionRows).toHaveLength(1)
  })

  it("a decided package cannot be re-decided: a later approve after reject is 409 and changes nothing", async () => {
    const { store, pkgId, draftId } = await pendingPackage()
    expect((await decide("partner_c", pkgId, "reject", "no")).status).toBe(200)
    const again = await decide("partner_a", pkgId, "approve", "flip")
    expect(again.status).toBe(409)
    const final = store.filingPackages.get(pkgId)!
    expect(final.status).toBe("rejected")
    expect(final.approvedBy).toBe("partner_c")
    expect(final.approvalReason).toBe("no")
    expect(store.drafts.get(draftId)?.locked).toBe(false)
  })
})

describe("FilingRepository.decideIfPending (memory)", () => {
  function pkg(status: FilingPackage["status"]): FilingPackage {
    return {
      id: "pkg_1", firmId: "firmA", matterId: "mat_1", draftId: "drf_1", classification: "internal",
      citationStatus: "OK", temporalAllOk: true, status, createdBy: "associate_a", createdAt: 1,
      approvedBy: null, approvalReason: null, draftBodySha256: "x", citedRefs: [],
    } as FilingPackage
  }
  const patch = { status: "approved" as const, approvedBy: "partner_a", approvalReason: "ok" }

  it("applies the decision only while pending", async () => {
    const repos = createMemoryRepositories(newStore())
    await repos.filings.create(pkg("pending_partner_approval"))
    expect(await repos.filings.decideIfPending("pkg_1", patch)).toMatchObject({ kind: "decided", row: { status: "approved" } })
    expect(await repos.filings.decideIfPending("pkg_1", { ...patch, status: "rejected" })).toEqual({ kind: "already_decided" })
    expect((await repos.filings.get("pkg_1", "firmA"))?.status).toBe("approved")
    expect(await repos.filings.decideIfPending("pkg_missing", patch)).toEqual({ kind: "missing" })
  })
})
