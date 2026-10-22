// Audit F13 FA-F13-003: the one-off backfill writes the canonical defaults into legacy matter and member rows, so a
// legacy member (no createdAt) appears in Cloud Functions listMatters and a legacy Next matter stores its stage.
// It only adds missing fields, never replaces a stored value, skips malformed and orphaned rows, and is idempotent.
// Auth + Firestore emulators.
import { randomUUID } from "node:crypto"
import { FieldValue } from "firebase-admin/firestore"
import { describe, expect, it } from "vitest"
import {
  applyMatterShapeBackfill,
  planMatterShapeBackfill,
  type MatterShapeBackfillStore,
} from "@/platform/persistence/matterShapeBackfill"
import { adminMatterShapeBackfillStore, readMatterShapeRows } from "@/scripts/lib/matterShapeBackfillAdmin"
import { adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS } from "@/tests/helpers/emulator-require"
import { mintIdToken, uniq } from "@/functions/test/emu"
import { viaApi } from "@/functions/test/api"

const E2E_TIMEOUT_MS = 90_000
const listMatters = viaApi<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>("listMatters")

async function newFirm(): Promise<string> {
  const firmId = uniq("f13b3firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F13", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  return firmId
}

/** A matter as Next wrote it before the canonical document: no stage, matterNo, conflictCheckId or createdBy. */
async function legacyNextMatter(firmId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = uniq("m")
  await adminDb().collection("matters").doc(id).set({
    firmId, clientId: uniq("c"), title: "Recovery suit", classification: "internal", status: "live",
    courtId: "LHC", caseNumber: null, caseNumberStatus: "pending", ...extra,
  })
  return id
}

/** A member row as Next seated it before the canonical row: no createdAt, addedBy or classification. */
async function legacyMember(firmId: string, matterId: string, userId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = `${matterId}_${userId}`
  await adminDb().collection("matter_members").doc(id).set({ firmId, matterId, userId, ...extra })
  return id
}

const store = (): MatterShapeBackfillStore => adminMatterShapeBackfillStore(adminDb() as never, () => FieldValue.serverTimestamp())
const data = async (col: string, id: string) => (await adminDb().collection(col).doc(id).get()).data() as Record<string, unknown>

/** Plans over this test's own rows only (other tests share the emulator). */
async function planFor(firmId: string) {
  const { matters, members } = await readMatterShapeRows(adminDb() as never)
  return planMatterShapeBackfill(
    matters.filter((r) => r.data.firmId === firmId),
    members.filter((r) => r.data.firmId === firmId)
  )
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-003: legacy matter / member backfill", { timeout: E2E_TIMEOUT_MS }, () => {
  it("a legacy member appears in listMatters, and the legacy matter stores its stage, only after the backfill", async () => {
    const firmId = await newFirm()
    const partner = await mintIdToken({ firmId, role: "partner", clearanceLevel: "privileged-restricted" })
    const matterId = await legacyNextMatter(firmId)
    const memberId = await legacyMember(firmId, matterId, partner.uid)
    const before = await listMatters({ token: partner.token, data: { firmId } } as never)
    expect(before.items.map((m) => m.matterId ?? m.id)).not.toContain(matterId)

    const res = await applyMatterShapeBackfill(store(), await planFor(firmId), { runId: randomUUID(), now: Date.now() })
    expect(res.applied).toEqual(expect.arrayContaining([`matters/${matterId}`, `matter_members/${memberId}`]))

    expect(await data("matters", matterId)).toMatchObject({ stage: "pre_filing", matterNo: null, conflictCheckId: null, createdBy: null, courtId: "LHC" })
    const member = await data("matter_members", memberId)
    expect(member).toMatchObject({ classification: "internal", addedBy: null })
    expect(member.createdAt).toBeDefined()
    const after = await listMatters({ token: partner.token, data: { firmId } } as never)
    expect(after.items.map((m) => m.matterId ?? m.id)).toContain(matterId)
  })

  it("never replaces a stored value, and a second run writes nothing", async () => {
    const firmId = await newFirm()
    const matterId = await legacyNextMatter(firmId, { stage: "hearing", createdBy: "u_orig" })
    const memberId = await legacyMember(firmId, matterId, uniq("u"), { classification: "confidential", addedBy: "u_add" })
    await applyMatterShapeBackfill(store(), await planFor(firmId), { runId: randomUUID(), now: Date.now() })
    expect(await data("matters", matterId)).toMatchObject({ stage: "hearing", createdBy: "u_orig", matterNo: null })
    expect(await data("matter_members", memberId)).toMatchObject({ classification: "confidential", addedBy: "u_add" })
    const second = await planFor(firmId)
    expect(second.matters).toEqual([])
    expect(second.members).toEqual([])
    expect(second.complete).toEqual(expect.arrayContaining([`matters/${matterId}`, `matter_members/${memberId}`]))
  })

  it("a value written between plan and apply wins (the write re-checks in its transaction)", async () => {
    const firmId = await newFirm()
    const matterId = await legacyNextMatter(firmId)
    const plan = await planFor(firmId)
    await adminDb().collection("matters").doc(matterId).update({ stage: "filed" })
    await applyMatterShapeBackfill(store(), plan, { runId: randomUUID(), now: Date.now() })
    expect(await data("matters", matterId)).toMatchObject({ stage: "filed", matterNo: null })
  })

  it("leaves malformed matters and orphaned members (no matter, other firm, mismatched id) untouched, and audits the run", async () => {
    const firmId = await newFirm()
    const otherFirm = await newFirm()
    const bad = await legacyNextMatter(firmId, { title: 123 })
    const good = await legacyNextMatter(firmId)
    const noMatter = await legacyMember(firmId, uniq("gone"), uniq("u"))
    const crossFirm = `${good}_${uniq("u")}`
    await adminDb().collection("matter_members").doc(crossFirm).set({ firmId: otherFirm, matterId: good, userId: crossFirm.split("_").pop() })
    const misnamed = uniq("odd")
    await adminDb().collection("matter_members").doc(misnamed).set({ firmId, matterId: good, userId: uniq("u") })
    const plan = planMatterShapeBackfill(
      (await readMatterShapeRows(adminDb() as never)).matters.filter((r) => r.data.firmId === firmId),
      (await readMatterShapeRows(adminDb() as never)).members.filter((r) => r.data.firmId === firmId || r.data.firmId === otherFirm)
    )
    expect(plan.malformed).toContain(`matters/${bad}`)
    expect(plan.orphans).toEqual(expect.arrayContaining([`matter_members/${noMatter}`, `matter_members/${crossFirm}`, `matter_members/${misnamed}`]))
    const runId = randomUUID()
    await applyMatterShapeBackfill(store(), plan, { runId, now: Date.now() })
    expect((await data("matters", bad)).stage).toBeUndefined()
    for (const id of [noMatter, crossFirm, misnamed]) {
      const row = await data("matter_members", id)
      expect(row.createdAt, id).toBeUndefined()
      expect(row.classification, id).toBeUndefined()
    }
    expect(await data("audit_log", `aud_matter_shape_backfill_${runId}`)).toMatchObject({
      action: "matter_shape_backfill",
      malformedCount: 1,
      orphanCount: 3,
    })
    expect(await data("audit_log", `aud_matter_shape_backfill_${runId}_malformed_0`)).toMatchObject({ malformed: [`matters/${bad}`] })
    expect((await data("audit_log", `aud_matter_shape_backfill_${runId}_orphans_0`)).orphans).toEqual(
      expect.arrayContaining([`matter_members/${noMatter}`])
    )
    expect((await data("audit_log", `aud_matter_shape_backfill_${runId}_b0_planned`)).planned).toEqual([`matters/${good}`])
  })
})

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-018: apply re-reads the member's matter", { timeout: E2E_TIMEOUT_MS }, () => {
  it("a member takes its matter's classification at apply time, not plan time", async () => {
    const firmId = await newFirm()
    const matterId = await legacyNextMatter(firmId, { stage: "pre_filing" })
    const memberId = await legacyMember(firmId, matterId, uniq("u"))
    const plan = await planFor(firmId)
    await adminDb().collection("matters").doc(matterId).update({ classification: "privileged-restricted" })
    const res = await applyMatterShapeBackfill(store(), plan, { runId: randomUUID(), now: Date.now() })
    expect(res.applied).toContain(`matter_members/${memberId}`)
    expect((await data("matter_members", memberId)).classification).toBe("privileged-restricted")
  })

  it.each([
    ["the member moved to another matter", async (_m: string, id: string) => adminDb().collection("matter_members").doc(id).update({ matterId: uniq("moved") })],
    ["the member moved to another firm", async (_m: string, id: string) => adminDb().collection("matter_members").doc(id).update({ firmId: uniq("otherfirm") })],
    ["the matter moved to another firm", async (m: string) => adminDb().collection("matters").doc(m).update({ firmId: uniq("otherfirm") })],
    ["the matter became malformed", async (m: string) => adminDb().collection("matters").doc(m).update({ classification: "top-secret" })],
    ["the matter was deleted", async (m: string) => adminDb().collection("matters").doc(m).delete()],
  ])("a member is rejected at apply and left untouched when, after planning, %s", async (_label, change) => {
    const firmId = await newFirm()
    const matterId = await legacyNextMatter(firmId, { stage: "pre_filing" })
    const memberId = await legacyMember(firmId, matterId, uniq("u"))
    const plan = await planFor(firmId)
    await change(matterId, memberId)
    const path = `matter_members/${memberId}`
    const res = await applyMatterShapeBackfill(store(), plan, { runId: randomUUID(), now: Date.now() })
    expect(res.skipped).not.toContain(path)
    expect(res.rejected.map((r) => r.path)).toContain(path)
    const row = await data("matter_members", memberId)
    expect(row.classification).toBeUndefined()
    expect(row.createdAt).toBeUndefined()
  })
})

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-019: a planned matter gone or malformed at apply is rejected", { timeout: E2E_TIMEOUT_MS }, () => {
  it.each([
    ["deleted", "matter_gone", async (m: string) => adminDb().collection("matters").doc(m).delete()],
    ["made malformed", "matter_malformed", async (m: string) => adminDb().collection("matters").doc(m).update({ classification: "top-secret" })],
  ] as const)("a matter %s after planning is rejected (%s), not reported as completed since planning", async (_label, reason, change) => {
    const firmId = await newFirm()
    const matterId = await legacyNextMatter(firmId)
    const plan = await planFor(firmId)
    expect(plan.matters.map((u) => u.id)).toContain(matterId)
    await change(matterId)
    const path = `matters/${matterId}`
    const runId = randomUUID()
    const res = await applyMatterShapeBackfill(store(), plan, { runId, now: Date.now() })
    expect(res.skipped).not.toContain(path)
    expect(res.applied).not.toContain(path)
    expect(res.rejected).toContainEqual({ path, reason })
    const row = (await adminDb().collection("matters").doc(matterId).get()).data()
    if (reason === "matter_gone") expect(row).toBeUndefined()
    else expect(row?.stage).toBeUndefined()
    const done = await data("audit_log", `aud_matter_shape_backfill_${runId}_b0_done`)
    expect(done.rejected).toContainEqual({ path, reason })
    expect((await data("audit_log", `aud_matter_shape_backfill_${runId}`)).rejectedCount).toBeGreaterThanOrEqual(1)
  })

  it("a matter whose missing fields were filled since planning is still skipped", async () => {
    const firmId = await newFirm()
    const matterId = await legacyNextMatter(firmId)
    const plan = await planFor(firmId)
    const patch = plan.matters.find((u) => u.id === matterId)!.patch
    await adminDb().collection("matters").doc(matterId).update(patch)
    const res = await applyMatterShapeBackfill(store(), plan, { runId: randomUUID(), now: Date.now() })
    expect(res.skipped).toContain(`matters/${matterId}`)
    expect(res.rejected.map((r) => r.path)).not.toContain(`matters/${matterId}`)
  })
})

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("F13 FA-F13-003: the backfill CLI runs through the pinned runner", { timeout: E2E_TIMEOUT_MS }, () => {
  it("npm run backfill:matter-shapes (tsx, a pinned devDependency) dry-runs and writes nothing", async () => {
    const { execFileSync } = await import("node:child_process")
    const pkg = (await import("@/package.json", { with: { type: "json" } })).default as { devDependencies: Record<string, string>; scripts: Record<string, string> }
    expect(pkg.devDependencies.tsx).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.scripts["backfill:matter-shapes"]).toBe("tsx scripts/backfill-matter-shapes.ts")
    const firmId = await newFirm()
    const matterId = await legacyNextMatter(firmId)
    const out = execFileSync("npm", ["run", "-s", "backfill:matter-shapes", "--", "--project", process.env.GCLOUD_PROJECT ?? "demo-sikander"], {
      env: { ...process.env },
      encoding: "utf8",
    })
    expect(out).toContain("[backfill-matter-shapes] DRY-RUN")
    expect((await data("matters", matterId)).stage).toBeUndefined()
  })
})
