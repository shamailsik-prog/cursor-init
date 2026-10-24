// Audit FA-D4-001: the one-off backfill moves legacy `draft_template_analytics/template:{T}` rows to
// `template:{firmId}:{T}`. A row several firms shared (drafts of T exist for a firm other than the one it is stamped
// with) cannot be split: it is reported with ids only and left. Malformed rows are reported and left. A move re-reads
// both rows in one transaction, merges into a row the firm wrote since deploy, and deletes the legacy row, so a rerun
// moves nothing. Firestore emulator, Admin SDK (the operator script's own store).
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  applyTemplateAnalyticsBackfill,
  formatTemplateAnalyticsBackfillDryRun,
  planTemplateAnalyticsBackfill,
  type TemplateAnalyticsBackfillStore,
} from "@/platform/persistence/draftTemplateAnalyticsBackfill"
import {
  adminTemplateAnalyticsBackfillStore,
  readTemplateAnalyticsBackfillInput,
} from "@/scripts/lib/draftTemplateAnalyticsBackfillAdmin"
import { runTemplateAnalyticsBackfill } from "@/scripts/lib/draftTemplateAnalyticsBackfillCli"
import { adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS } from "@/tests/helpers/emulator-require"

const E2E_TIMEOUT_MS = 90_000
const COLL = "draft_template_analytics"

const short = () => randomUUID().replaceAll("-", "").slice(0, 10)
const firm = () => `fad4bf-firm-${short()}`
/** Synthetic template ids, so no other suite's rows or drafts share them. */
const tpl = () => `fad4bf_${short()}`

function row(firmId: string, templateId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firmId,
    templateId,
    templateName: "Synthetic template",
    templatePosture: "writ",
    templateCategory: "constitutional",
    composeCount: 3,
    templateSearchCount: 1,
    lastComposedAt: 60,
    lastTemplateSearchAt: 50,
    lastTemplateSearchQuery: "old query",
    updatedAt: 60,
    ...extra,
  }
}

const ref = (id: string) => adminDb().collection(COLL).doc(id)
const data = async (id: string) => (await ref(id).get()).data()
async function seed(id: string, value: Record<string, unknown>): Promise<string> {
  await ref(id).set(value)
  return id
}
async function draftOf(firmId: string, templateId: string): Promise<void> {
  await adminDb().collection("drafts").doc(`drf_fad4bf_${short()}`).set({ firmId, templateId, matterId: "m", title: "t", body: "b" })
}

const store = (): TemplateAnalyticsBackfillStore => adminTemplateAnalyticsBackfillStore(adminDb())

/** The loader's input restricted to this test's own rows (other suites share the emulator). */
async function inputFor(ids: string[]) {
  const input = await readTemplateAnalyticsBackfillInput(adminDb())
  return { ...input, rows: input.rows.filter((r) => ids.includes(r.id)) }
}
async function planFor(ids: string[]) {
  const input = await inputFor(ids)
  return planTemplateAnalyticsBackfill(input.rows, input.draftFirmsByTemplate)
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("FA-D4-001: legacy template analytics backfill", { timeout: E2E_TIMEOUT_MS }, () => {
  it("the dry run names every row and writes nothing", async () => {
    const [f, g] = [firm(), firm()]
    const [t1, t2, t3, t4] = [tpl(), tpl(), tpl(), tpl()]
    await draftOf(f, t1)
    await draftOf(f, t3)
    await draftOf(g, t3)
    const ids = [
      await seed(`template:${t1}`, row(f, t1)),
      await seed(`template:${f}:${t2}`, row(f, t2)),
      await seed(`template:${t3}`, row(f, t3)),
      await seed(`template:${t4}`, row(f, t4, { composeCount: "3" })),
    ]
    const before = await Promise.all(ids.map(data))
    const plan = await planFor(ids)
    const text = formatTemplateAnalyticsBackfillDryRun(plan)
    expect(text).toContain("[backfill-template-analytics] DRY-RUN: 1 legacy rows to move, 1 already canonical, 1 unrecoverable")
    expect(text).toContain(`[backfill-template-analytics] move ${COLL}/template:${t1} -> ${COLL}/template:${f}:${t1}`)
    expect(text).toContain(`[backfill-template-analytics] canonical ${COLL}/template:${f}:${t2}`)
    expect(text).toContain(`[backfill-template-analytics] unrecoverable ${COLL}/template:${t3} firms=${[f, g].sort().join(",")}`)
    expect(text).toContain(`[backfill-template-analytics] malformed ${COLL}/template:${t4}`)

    const lines: string[] = []
    const code = await runTemplateAnalyticsBackfill([], { load: () => inputFor(ids), store: store(), log: (l) => lines.push(l) })
    expect(code).toBe(2)
    expect(lines.join("\n")).toContain("DRY-RUN")
    expect(await Promise.all(ids.map(data))).toEqual(before)
    expect(await data(`template:${f}:${t1}`)).toBeUndefined()
  })

  it("apply moves a clean legacy row to the firm's id, deletes the legacy id, and a rerun moves nothing", async () => {
    const f = firm()
    const t = tpl()
    await draftOf(f, t)
    const legacy = await seed(`template:${t}`, row(f, t, { id: `template:${t}` }))
    const runId = randomUUID()
    const res = await applyTemplateAnalyticsBackfill(store(), await planFor([legacy]), { runId, now: 1000 })
    expect(res.moved).toEqual([`${COLL}/template:${t}`])
    expect(await data(legacy)).toBeUndefined()
    expect(await data(`template:${f}:${t}`)).toEqual({ ...row(f, t), id: `template:${f}:${t}` })

    const second = await planFor([legacy, `template:${f}:${t}`])
    expect(second.moves).toEqual([])
    expect(second.canonical).toEqual([`${COLL}/template:${f}:${t}`])
    const rerun = await applyTemplateAnalyticsBackfill(store(), second, { runId: randomUUID(), now: 2000 })
    expect(rerun).toEqual({ moved: [], merged: [], rejected: [], failed: [] })
    expect(await data(`template:${f}:${t}`)).toEqual({ ...row(f, t), id: `template:${f}:${t}` })
    expect(await (await adminDb().collection("audit_log").doc(`aud_template_analytics_backfill_${runId}`).get()).data()).toMatchObject({
      action: "template_analytics_backfill",
      firmId: "_platform",
      movedCount: 1,
      mergedCount: 0,
      unrecoverableCount: 0,
    })
  })

  it("apply merges into a row the firm wrote since deploy: counts summed, the later timestamps and query kept", async () => {
    const f = firm()
    const t = tpl()
    await draftOf(f, t)
    const legacy = await seed(`template:${t}`, row(f, t))
    const target = await seed(
      `template:${f}:${t}`,
      row(f, t, { composeCount: 2, templateSearchCount: 4, lastComposedAt: 80, lastTemplateSearchAt: 90, lastTemplateSearchQuery: "new query", updatedAt: 95 })
    )
    const res = await applyTemplateAnalyticsBackfill(store(), await planFor([legacy]), { runId: randomUUID(), now: 1000 })
    expect(res.merged).toEqual([`${COLL}/template:${t}`])
    expect(await data(legacy)).toBeUndefined()
    expect(await data(target)).toEqual({
      id: target,
      firmId: f,
      templateId: t,
      templateName: "Synthetic template",
      templatePosture: "writ",
      templateCategory: "constitutional",
      composeCount: 5,
      templateSearchCount: 5,
      lastComposedAt: 80,
      lastTemplateSearchAt: 90,
      lastTemplateSearchQuery: "new query",
      updatedAt: 95,
    })
  })

  it("a merge keeps the legacy row's search fields when they are the later ones", async () => {
    const f = firm()
    const t = tpl()
    await draftOf(f, t)
    const legacy = await seed(`template:${t}`, row(f, t, { lastComposedAt: 70, lastTemplateSearchAt: 99, lastTemplateSearchQuery: "legacy later", updatedAt: 99 }))
    const target = await seed(`template:${f}:${t}`, row(f, t, { composeCount: 1, templateSearchCount: 0, lastComposedAt: 65, lastTemplateSearchAt: null, lastTemplateSearchQuery: null, updatedAt: 65 }))
    await applyTemplateAnalyticsBackfill(store(), await planFor([legacy]), { runId: randomUUID(), now: 1000 })
    expect(await data(target)).toMatchObject({
      composeCount: 4,
      templateSearchCount: 1,
      lastComposedAt: 70,
      lastTemplateSearchAt: 99,
      lastTemplateSearchQuery: "legacy later",
      updatedAt: 99,
    })
  })

  it("a legacy row several firms shared is reported with ids only, and neither moved nor deleted", async () => {
    const [f, g] = [firm(), firm()]
    const t = tpl()
    await draftOf(f, t)
    await draftOf(g, t)
    const legacy = await seed(`template:${t}`, row(g, t, { lastTemplateSearchQuery: "fad4bf secret query" }))
    const before = await data(legacy)
    const plan = await planFor([legacy])
    expect(plan.unrecoverable).toEqual([{ path: `${COLL}/template:${t}`, firmIds: [f, g].sort() }])
    expect(plan.moves).toEqual([])
    const runId = randomUUID()
    const lines: string[] = []
    const code = await runTemplateAnalyticsBackfill(["--apply"], {
      load: () => inputFor([legacy]),
      store: store(),
      log: (l) => lines.push(l),
      runId,
      now: 1000,
    })
    expect(code).toBe(2)
    expect(lines.join("\n")).toContain(`unrecoverable ${COLL}/template:${t} firms=${[f, g].sort().join(",")}`)
    expect(await data(legacy)).toEqual(before)
    expect(await data(`template:${f}:${t}`)).toBeUndefined()
    expect(await data(`template:${g}:${t}`)).toBeUndefined()
    const audit = (await adminDb().collection("audit_log").doc(`aud_template_analytics_backfill_${runId}_unrecoverable_0`).get()).data()
    expect(audit?.unrecoverable).toEqual([{ path: `${COLL}/template:${t}`, firmIds: [f, g].sort() }])
    expect(JSON.stringify(audit)).not.toContain("fad4bf secret query")
    expect(JSON.stringify(audit)).not.toContain("composeCount")
    expect((await adminDb().collection("audit_log").doc(`aud_template_analytics_backfill_${runId}`).get()).data()).toMatchObject({
      unrecoverableCount: 1,
      movedCount: 0,
    })
  })

  it.each([
    ["a non-integer count", (f: string, t: string) => row(f, t, { composeCount: 1.5 })],
    ["a templateId that is not the id's", (f: string) => row(f, "fad4bf_other")],
    ["no firm", (_f: string, t: string) => row("", t)],
    ["a firm id with a colon", (_f: string, t: string) => row("fad4bf:colon", t)],
  ])("a legacy row with %s is reported malformed and left", async (_label, make) => {
    const f = firm()
    const t = tpl()
    const legacy = await seed(`template:${t}`, make(f, t))
    const before = await data(legacy)
    const plan = await planFor([legacy])
    expect(plan.malformed).toEqual([`${COLL}/template:${t}`])
    expect(plan.moves).toEqual([])
    await applyTemplateAnalyticsBackfill(store(), plan, { runId: randomUUID(), now: 1000 })
    expect(await data(legacy)).toEqual(before)
  })

  it("a legacy row changed between plan and apply is rejected and left for a rerun", async () => {
    const f = firm()
    const t = tpl()
    const legacy = await seed(`template:${t}`, row(f, t))
    const plan = await planFor([legacy])
    await ref(legacy).update({ composeCount: 4 })
    const res = await applyTemplateAnalyticsBackfill(store(), plan, { runId: randomUUID(), now: 1000 })
    expect(res.rejected).toEqual([{ path: `${COLL}/template:${t}`, reason: "legacy_changed" }])
    expect((await data(legacy))?.composeCount).toBe(4)
    expect(await data(`template:${f}:${t}`)).toBeUndefined()
  })

  it("a target at the firm's id stamped with another firm is rejected; both rows are left", async () => {
    const [f, g] = [firm(), firm()]
    const t = tpl()
    const legacy = await seed(`template:${t}`, row(f, t))
    const foreign = await seed(`template:${f}:${t}`, row(g, t, { composeCount: 9 }))
    const plan = await planFor([legacy, foreign])
    expect(plan.malformed).toEqual([`${COLL}/template:${f}:${t}`])
    const res = await applyTemplateAnalyticsBackfill(store(), plan, { runId: randomUUID(), now: 1000 })
    expect(res.rejected).toEqual([{ path: `${COLL}/template:${t}`, reason: "target_foreign_firm" }])
    expect(await data(legacy)).toEqual(row(f, t))
    expect(await data(foreign)).toEqual(row(g, t, { composeCount: 9 }))
  })

  it("apply exits 1 when a write throws, still runs the later rows, and exits 0 on a clean run", async () => {
    const f = firm()
    const [t1, t2] = [tpl(), tpl()]
    const ids = [await seed(`template:${t1}`, row(f, t1)), await seed(`template:${t2}`, row(f, t2))]
    const real = store()
    const flaky: TemplateAnalyticsBackfillStore = {
      move: async (planned) => {
        if (planned.from === `template:${t1}`) throw new Error("simulated write failure")
        return real.move(planned)
      },
      appendAudit: real.appendAudit,
    }
    const failedRun = await runTemplateAnalyticsBackfill(["--apply"], { load: () => inputFor(ids), store: flaky, log: () => undefined })
    expect(failedRun).toBe(1)
    expect(await data(`template:${f}:${t2}`)).toMatchObject({ composeCount: 3 })
    expect(await data(`template:${t1}`)).toEqual(row(f, t1))
    const clean = await runTemplateAnalyticsBackfill(["--apply"], { load: () => inputFor(ids), store: store(), log: () => undefined })
    expect(clean).toBe(0)
    expect(await data(`template:${t1}`)).toBeUndefined()
    expect(await data(`template:${f}:${t1}`)).toMatchObject({ composeCount: 3 })
  })
})
