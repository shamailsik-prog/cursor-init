// Audit FA-D4-001-FU1 (spec R12, R13): the one-off backfill moves legacy court-ops acknowledgement rows
// `workflow_ops_activity/ops:court_ops:ack:{queueType}:{itemId}` to `ops:court_ops:ack:{firmId}:{queueType}:{itemId}` when
// the item is evidently the stamped firm's (document_workflow / follow_ups carry that firm). Every other ack row an
// operator must look at is reported by id and left: item_not_in_firm, malformed (FU1b's arbitrary queueType),
// nested (FU1b's '/'), target_conflict. Exit codes (the FA-D4-001-R1-004 lesson): 0 only for a clean run, 1 when a rerun
// can finish the job, 2 when an operator must act, and "rerun to retry" is never printed for those.
// Firestore emulator, Admin SDK (the operator script's own loader and store).
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import type { CourtOpsAckBackfillStore } from "@/platform/persistence/courtOpsAckBackfill"
import { adminCourtOpsAckBackfillStore, readCourtOpsAckBackfillInput } from "@/scripts/lib/courtOpsAckBackfillAdmin"
import { runCourtOpsAckBackfill } from "@/scripts/lib/courtOpsAckBackfillCli"
import { adminDb } from "@/tests/helpers/emulator-auth"
import { HAS_AUTH_FIRESTORE_EMULATORS } from "@/tests/helpers/emulator-require"
import { deleteFirmRows } from "@/tests/helpers/firm-cleanup"

const E2E_TIMEOUT_MS = 120_000
const COLL = "workflow_ops_activity"
const SECRET = "SECRET-DETAIL-do-not-print"

const short = () => randomUUID().replaceAll("-", "").slice(0, 10)
/** The firms and nested documents this suite creates; afterAll deletes them (audit F42: an emulator e2e cleans up its firms). */
const created = { firmIds: new Set<string>(), paths: new Set<string>() }
const firm = () => {
  const id = `fu1bf-firm-${short()}`
  created.firmIds.add(id)
  return id
}
const ackId = (firmId: string, queueType: string, item: string) => `ops:court_ops:ack:${firmId}:${queueType}:${item}`
const legacyId = (queueType: string, item: string) => `ops:court_ops:ack:${queueType}:${item}`

function ack(firmId: string, queueType: string, item: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firmId,
    source: "court_ops",
    action: "court_ops_acknowledge",
    actorId: `${firmId}-actor`,
    classification: "internal",
    matterId: null,
    documentId: queueType === "workflow" ? item : null,
    followUpId: queueType === "follow_up" ? item : null,
    queueType,
    status: "acknowledged",
    detail: SECRET,
    tags: ["court", "ops"],
    createdAt: 100,
    ...extra,
  }
}

const ref = (id: string) => adminDb().collection(COLL).doc(id)
const data = async (id: string) => (await ref(id).get()).data()
async function seed(id: string, value: Record<string, unknown>): Promise<string> {
  await ref(id).set(value)
  return id
}
async function workflowItem(firmId: string): Promise<string> {
  const id = `doc_fu1bf_${short()}`
  await adminDb().collection("document_workflow").doc(id).set({ documentId: id, firmId, matterId: null, status: "review_required", reviewerId: null, updatedAt: 1 })
  return id
}
async function followUp(firmId: string): Promise<string> {
  const id = `fu_fu1bf_${short()}`
  await adminDb().collection("follow_ups").doc(id).set({ id, firmId, matterId: "m", courtId: "SHC", raw: "x", kind: "case_number_reject", status: "open" })
  return id
}

/** The loader's input restricted to this test's own rows (other suites share the emulator). */
function depsFor(ids: string[], tag: string, store: CourtOpsAckBackfillStore = adminCourtOpsAckBackfillStore(adminDb())) {
  const lines: string[] = []
  return {
    lines,
    deps: {
      load: async () => {
        const input = await readCourtOpsAckBackfillInput(adminDb())
        return { ...input, rows: input.rows.filter((r) => ids.includes(r.id)), nested: input.nested.filter((n) => n.path.includes(tag)) }
      },
      store,
      log: (line: string) => lines.push(line),
      now: 1_000,
    },
  }
}

describe.runIf(HAS_AUTH_FIRESTORE_EMULATORS)("FA-D4-001-FU1: legacy court-ops acknowledgement backfill", { timeout: E2E_TIMEOUT_MS }, () => {
  afterAll(async () => {
    const left = await deleteFirmRows({ firmIds: created.firmIds, paths: created.paths })
    expect(left.deleted, "the cleanup found this suite's rows").toBeGreaterThan(0)
    expect(left.remaining, "rows of this suite's firms left after cleanup").toBe(0)
  }, E2E_TIMEOUT_MS)

  it("the dry run names every class (ids only), predicts the target conflict, writes nothing, and exits 2", async () => {
    const [f, g, tag] = [firm(), firm(), short()]
    const [w1, w3, w4] = [await workflowItem(f), `doc_fu1bf_absent_${short()}`, await workflowItem(f)]
    const [fu2, fu5] = [await followUp(g), await followUp(f)]
    const ids = [
      await seed(ackId(f, "workflow", `doc_canon_${tag}`), ack(f, "workflow", `doc_canon_${tag}`)),
      await seed(legacyId("workflow", w1), ack(f, "workflow", w1)),
      await seed(legacyId("follow_up", fu2), ack(f, "follow_up", fu2)),
      await seed(legacyId("workflow", w3), ack(f, "workflow", w3)),
      await seed(legacyId(`zz${tag}`, `i${tag}`), ack(f, `zz${tag}`, `i${tag}`, { documentId: null })),
      await seed(legacyId("workflow", w4), ack(f, "workflow", w4)),
      await seed(ackId(f, "workflow", w4), ack(g, "workflow", w4)),
      await seed(legacyId("follow_up", fu5), ack(f, "follow_up", fu5)),
      await seed(ackId(f, "follow_up", fu5), ack(f, "follow_up", fu5, { createdAt: 500, detail: "later" })),
    ]
    created.paths.add(`${COLL}/ops:court_ops:ack:workflow:p${tag}/sub/d${tag}`)
    await adminDb().doc(`${COLL}/ops:court_ops:ack:workflow:p${tag}/sub/d${tag}`).set(ack(f, "workflow", `p${tag}`))
    const before = await Promise.all(ids.map(data))
    const { lines, deps } = depsFor(ids, tag)
    expect(await runCourtOpsAckBackfill([], deps)).toBe(2)
    const out = lines.join("\n")
    expect(out).toContain("DRY-RUN: 2 legacy rows to move")
    expect(out).toContain(`move ${COLL}/${legacyId("workflow", w1)} -> ${COLL}/${ackId(f, "workflow", w1)}`)
    expect(out).toContain(`move ${COLL}/${legacyId("follow_up", fu5)} -> ${COLL}/${ackId(f, "follow_up", fu5)}`)
    expect(out).toMatch(new RegExp(`needs operator review ${COLL}/${legacyId("follow_up", fu2)} item_not_in_firm firms=${[f, g].sort().join(",")}`))
    expect(out).toContain(`needs operator review ${COLL}/${legacyId("workflow", w3)} item_not_in_firm firms=${f}`)
    expect(out).toContain(`needs operator review ${COLL}/${legacyId(`zz${tag}`, `i${tag}`)} malformed`)
    expect(out).toContain(`needs operator review ${COLL}/${legacyId("workflow", w4)} target_conflict firms=${[f, g].sort().join(",")}`)
    expect(out).toContain(`needs operator review ${COLL}/ops:court_ops:ack:workflow:p${tag}/sub/d${tag} nested`)
    expect(out).toContain(`canonical ${COLL}/${ackId(f, "workflow", `doc_canon_${tag}`)}`)
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain("rerun to retry")
    expect(await Promise.all(ids.map(data))).toEqual(before)
  })

  it("apply moves and merges (keeping the later acknowledgement), deletes the legacy rows, leaves the rest, audits, and a rerun moves nothing", async () => {
    const [f, g, tag] = [firm(), firm(), short()]
    const [w1, fu2, fu5] = [await workflowItem(f), await followUp(g), await followUp(f)]
    const ids = [
      await seed(legacyId("workflow", w1), ack(f, "workflow", w1)),
      await seed(legacyId("follow_up", fu2), ack(f, "follow_up", fu2)),
      await seed(legacyId("follow_up", fu5), ack(f, "follow_up", fu5, { createdAt: 900, detail: "legacy is later" })),
      await seed(ackId(f, "follow_up", fu5), ack(f, "follow_up", fu5, { createdAt: 500 })),
      ackId(f, "workflow", w1),
    ]
    const notInFirm = await data(legacyId("follow_up", fu2))
    const runId = `fu1bf-${tag}`
    const { lines, deps } = depsFor(ids, tag)
    expect(await runCourtOpsAckBackfill(["--apply"], { ...deps, runId })).toBe(2)
    // The moved row is the legacy row re-keyed: its own fields, with `id` the firm-qualified id (as the route writes it).
    expect(await data(ackId(f, "workflow", w1))).toEqual({ id: ackId(f, "workflow", w1), ...ack(f, "workflow", w1) })
    expect(await data(legacyId("workflow", w1))).toBeUndefined()
    expect(await data(ackId(f, "follow_up", fu5))).toMatchObject({ createdAt: 900, detail: "legacy is later", firmId: f })
    expect(await data(legacyId("follow_up", fu5))).toBeUndefined()
    expect(await data(legacyId("follow_up", fu2))).toEqual(notInFirm)
    const out = lines.join("\n")
    expect(out).toContain("moved 1, merged 1")
    expect(out).toContain(`needs operator review ${COLL}/${legacyId("follow_up", fu2)} item_not_in_firm`)
    expect(out).not.toContain("rerun to retry")
    expect(out).not.toContain(SECRET)
    const summary = (await adminDb().collection("audit_log").doc(`aud_court_ops_ack_backfill_${runId}`).get()).data()
    expect(summary).toMatchObject({ action: "court_ops_ack_backfill", movedCount: 1, mergedCount: 1, needsOperatorCount: 1, failedCount: 0, retryCount: 0 })
    expect(JSON.stringify(summary)).not.toContain(SECRET)

    const rerun = depsFor(ids, tag)
    expect(await runCourtOpsAckBackfill(["--apply"], { ...rerun.deps, runId: `${runId}-2` })).toBe(2)
    expect(rerun.lines.join("\n")).toContain("APPLY: 0 legacy rows to move, 2 already canonical")
  })

  it("a clean run (only movable and canonical rows) exits 0, and its rerun exits 0 with nothing to move", async () => {
    const [f, tag] = [firm(), short()]
    const w = await workflowItem(f)
    const ids = [await seed(legacyId("workflow", w), ack(f, "workflow", w)), ackId(f, "workflow", w)]
    const first = depsFor(ids, tag)
    expect(await runCourtOpsAckBackfill(["--apply"], { ...first.deps, runId: `fu1bf-clean-${tag}` })).toBe(0)
    expect(await data(ackId(f, "workflow", w))).toMatchObject({ firmId: f, documentId: w })
    const again = depsFor(ids, tag)
    expect(await runCourtOpsAckBackfill([], again.deps)).toBe(0)
    expect(again.lines.join("\n")).toContain("DRY-RUN: 0 legacy rows to move, 1 already canonical")
  })

  it("a target that turns foreign after planning is rejected at apply as needing an operator (exit 2), never 'rerun to retry'", async () => {
    const [f, g, tag] = [firm(), firm(), short()]
    const w = await workflowItem(f)
    const ids = [await seed(legacyId("workflow", w), ack(f, "workflow", w)), ackId(f, "workflow", w)]
    const real = adminCourtOpsAckBackfillStore(adminDb())
    const racing: CourtOpsAckBackfillStore = {
      ...real,
      move: async (planned) => {
        await ref(planned.to).set(ack(g, "workflow", w))
        return real.move(planned)
      },
    }
    const { lines, deps } = depsFor(ids, tag, racing)
    expect(await runCourtOpsAckBackfill(["--apply"], { ...deps, runId: `fu1bf-race-${tag}` })).toBe(2)
    const out = lines.join("\n")
    expect(out).toContain(`needs operator review ${COLL}/${legacyId("workflow", w)} target_foreign_firm`)
    expect(out).not.toContain("rerun to retry")
    expect(await data(legacyId("workflow", w))).toMatchObject({ firmId: f })
    expect(await data(ackId(f, "workflow", w))).toMatchObject({ firmId: g })
  })

  it("a legacy row changed after planning, or a move that throws, exits 1 with 'rerun to retry', and later moves still run", async () => {
    const [f, tag] = [firm(), short()]
    const [w1, w2] = [await workflowItem(f), await workflowItem(f)]
    const ids = [
      await seed(legacyId("workflow", w1), ack(f, "workflow", w1)),
      await seed(legacyId("workflow", w2), ack(f, "workflow", w2)),
      ackId(f, "workflow", w1),
      ackId(f, "workflow", w2),
    ]
    const real = adminCourtOpsAckBackfillStore(adminDb())
    let calls = 0
    const flaky: CourtOpsAckBackfillStore = {
      ...real,
      move: async (planned) => {
        calls += 1
        if (planned.from === legacyId("workflow", w1)) {
          await ref(planned.from).set(ack(f, "workflow", w1, { detail: "rewritten by an old instance" }))
          return real.move(planned)
        }
        throw new Error("transient: deadline exceeded")
      },
    }
    const { lines, deps } = depsFor(ids, tag, flaky)
    expect(await runCourtOpsAckBackfill(["--apply"], { ...deps, runId: `fu1bf-flaky-${tag}` })).toBe(1)
    expect(calls).toBe(2)
    const out = lines.join("\n")
    expect(out).toContain(`rejected ${COLL}/${legacyId("workflow", w1)} legacy_changed (rerun to retry)`)
    expect(out).toContain(`failed ${COLL}/${legacyId("workflow", w2)}: transient: deadline exceeded (rerun to retry)`)
    expect(await data(legacyId("workflow", w1))).toMatchObject({ detail: "rewritten by an old instance" })
    // The rerun replans from what is stored now and finishes the job.
    const rerun = depsFor(ids, tag)
    expect(await runCourtOpsAckBackfill(["--apply"], { ...rerun.deps, runId: `fu1bf-flaky-${tag}-2` })).toBe(0)
    expect(await data(ackId(f, "workflow", w1))).toMatchObject({ detail: "rewritten by an old instance" })
    expect(await data(ackId(f, "workflow", w2))).toMatchObject({ firmId: f })
  })
})
