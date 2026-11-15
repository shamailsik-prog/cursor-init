/**
 * Gate G-3 proofs (Layer 18 §10; L17.5). In-memory store: no live database.
 * masterWritten is true only after a committed, readable version row.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { FEATURE_FLAGS } from "@/lib/foundation-data"
import { assertLearnersStopped, learnersMayRun } from "@/platform/p6/learners"
import { InMemoryMasterStore, type MasterStore } from "@/platform/p6/masterStore"
import {
  applyChange,
  approveProposal,
  proposeChange,
  rollbackMaster,
  type ApprovalActor,
} from "@/platform/p6/proposeChange"

const PARTNER: ApprovalActor = { actorId: "partner_a", kind: "partner", role: "partner" }

function p6Store(options?: { failCommit?: "throw" | "uncommitted" }): MasterStore {
  return new InMemoryMasterStore({ role: "p6_service", ...options })
}

function substantive(entryKey = "clause.nda.confidentiality") {
  return {
    firmId: "firmA",
    sourceModule: "learner-style",
    classification: "confidential" as const,
    changeClass: "substantive" as const,
    partition: "mutable" as const,
    entryKey,
    payload: { wording: "The receiving party shall keep the information secret." },
    proposedBy: "learner-1",
  }
}

function cosmetic() {
  return {
    firmId: "firmA",
    sourceModule: "learner-style",
    classification: "internal" as const,
    changeClass: "cosmetic" as const,
    partition: "mutable" as const,
    entryKey: "clause.order",
    payload: { order: ["b", "a"] },
    proposedBy: "learner-1",
  }
}

describe("G3 master owned (Layer 18 §10)", () => {
  it("G3-grants: only p6_service holds master write grants in the migration", () => {
    const sql = readFileSync("postgres/ddl/009_p6_master.sql", "utf8")
    const grants = [...sql.matchAll(/GRANT\s+([^;]+)\s+TO\s+([a-z0-9_]+)\s*;/gi)].map((m) => ({
      privilege: m[1].replace(/\s+/g, " ").trim(),
      grantee: m[2],
    }))
    expect(grants.length).toBeGreaterThan(0)
    for (const grant of grants) {
      expect(grant.grantee).toBe("p6_service")
    }
    expect(sql).toMatch(/CREATE ROLE p6_service NOLOGIN NOINHERIT/)
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.change_proposals, public\.master_versions, public\.master_knowledge FROM PUBLIC/)
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE public\.change_proposals TO p6_service/)
    expect(sql).toMatch(/GRANT SELECT, INSERT ON TABLE public\.master_versions TO p6_service/)
    expect(sql).toMatch(/GRANT SELECT, INSERT, UPDATE ON TABLE public\.master_knowledge TO p6_service/)
    expect(sql).not.toMatch(/GRANT\s+[^;]*\s+TO\s+(?!p6_service\b)[a-z0-9_]+/i)
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*TO/i)
    expect(sql).toMatch(/non-P6 writer refused/)
  })

  it("G3-approval: a substantive change needs a partner, and model or autonomous approval is refused", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive(), store)
    expect(pending.status).toBe("pending")

    await expect(applyChange(pending.id, store)).rejects.toThrow(/partner approval/)
    expect(await store.listVersions("firmA")).toEqual([])

    for (const actor of [
      { actorId: "model-1", kind: "model" as const, role: "partner" as const },
      { actorId: "auto-1", kind: "autonomous" as const, role: "partner" as const },
      { actorId: "associate_a", kind: "partner" as const, role: "associate" as const },
    ]) {
      await expect(approveProposal(pending.id, actor, store)).rejects.toThrow(/refused|partner approval/)
    }
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
    expect(await store.listVersions("firmA")).toEqual([])

    await approveProposal(pending.id, PARTNER, store)
    const applied = await applyChange(pending.id, store)
    expect(applied.masterWritten).toBe(true)
    expect((await store.getProposal(pending.id))?.decidedKind).toBe("partner")
  })

  it("G3-version-diff: apply writes a version row and a diff, and masterWritten follows that commit", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive(), store)
    await approveProposal(pending.id, PARTNER, store)
    const applied = await applyChange(pending.id, store)
    const versions = await store.listVersions("firmA")
    expect(versions).toHaveLength(1)
    expect(versions[0]?.id).toBe(applied.versionId)
    expect(versions[0]?.action).toBe("apply")
    expect(applied.diff.before.entries).toEqual({})
    expect(applied.diff.after.entries["clause.nda.confidentiality"]?.body).toEqual({
      wording: "The receiving party shall keep the information secret.",
    })
    expect(applied.diff).toEqual(versions[0]?.diff)
    const current = await store.currentSnapshot("firmA")
    expect(current).toEqual(applied.diff.after)

    const uncommitted = p6Store({ failCommit: "uncommitted" })
    const again = await proposeChange(substantive("clause.other"), uncommitted)
    await approveProposal(again.id, PARTNER, uncommitted)
    await expect(applyChange(again.id, uncommitted)).rejects.toThrow(/did not commit/)
    expect(await uncommitted.listVersions("firmA")).toEqual([])

    const exploding = p6Store({ failCommit: "throw" })
    const third = await proposeChange(substantive("clause.third"), exploding)
    await approveProposal(third.id, PARTNER, exploding)
    await expect(applyChange(third.id, exploding)).rejects.toThrow(/did not commit/)
    expect(await exploding.listVersions("firmA")).toEqual([])
  })

  it("G3-rollback: restores the prior version and records the rollback as a version", async () => {
    const store = p6Store()
    const first = await proposeChange(substantive("clause.one"), store)
    await approveProposal(first.id, PARTNER, store)
    const v1 = await applyChange(first.id, store)
    const second = await proposeChange(substantive("clause.two"), store)
    await approveProposal(second.id, PARTNER, store)
    const v2 = await applyChange(second.id, store)
    expect((await store.currentSnapshot("firmA")).entries["clause.two"]).toBeTruthy()

    const rolled = await rollbackMaster(
      { firmId: "firmA", toVersionId: v1.versionId, actor: PARTNER },
      store,
    )
    expect(rolled.masterWritten).toBe(true)
    expect(await store.currentSnapshot("firmA")).toEqual(v1.diff.after)
    const versions = await store.listVersions("firmA")
    expect(versions).toHaveLength(3)
    const rollback = versions[2]
    expect(rollback?.action).toBe("rollback")
    expect(rollback?.id).toBe(rolled.versionId)
    expect(rollback?.diff.before).toEqual(v2.diff.after)
    expect(rollback?.diff.after).toEqual(v1.diff.after)
    expect(rollback?.restoredFromVersionId).toBe(v1.versionId)

    await expect(
      rollbackMaster(
        {
          firmId: "firmA",
          toVersionId: v1.versionId,
          actor: { actorId: "model-1", kind: "model", role: "partner" },
        },
        store,
      ),
    ).rejects.toThrow(/refused/)
    expect(await store.listVersions("firmA")).toHaveLength(3)
  })

  it("G3-non-p6: a writer that is not the P6 service role is refused and writes nothing", async () => {
    const outsider = new InMemoryMasterStore({ role: "corpus_writer" })
    await expect(proposeChange(substantive(), outsider)).rejects.toThrow(/non-P6 writer refused/)
    expect(await outsider.listVersions("firmA")).toEqual([])
    const store = p6Store()
    const pending = await proposeChange(cosmetic(), store)
    const applied = await applyChange(pending.id, store)
    expect(applied.masterWritten).toBe(true)
    expect(applied.diff.after.entries["clause.order"]?.body).toEqual({ order: ["b", "a"] })
    await expect(
      proposeChange({ ...cosmetic(), changeClass: "cosmetic", payload: { wording: "smuggled clause" } }, store),
    ).rejects.toThrow(/substantive/)
    await expect(
      proposeChange({ ...substantive(), partition: "immutable", entryKey: "citation_protocol" }, store),
    ).rejects.toThrow(/immutable/)
  })

  it("G3-learners: learners stay off until G-3 has passed and the flag is on", () => {
    const ddl = readFileSync("postgres/ddl/002_platform.sql", "utf8")
    expect(ddl).toMatch(/\('LEARNERS_ENABLED','[^']*',false,'L17_5'\)/)
    expect(FEATURE_FLAGS.find((flag) => flag.flag === "LEARNERS_ENABLED")?.defaultEnabled).toBe(false)
    expect(learnersMayRun({ g3Passed: false, learnersFlag: false })).toBe(false)
    expect(learnersMayRun({ g3Passed: false, learnersFlag: true })).toBe(false)
    expect(learnersMayRun({ g3Passed: true, learnersFlag: false })).toBe(false)
    expect(() => assertLearnersStopped({ g3Passed: false, learnersFlag: true })).toThrow(/learners remain off until G3 passes/)
    expect(() => assertLearnersStopped({ g3Passed: true, learnersFlag: false })).toThrow(/learners remain off until G3 passes/)
    expect(learnersMayRun({ g3Passed: true, learnersFlag: true })).toBe(true)
  })

  it("proposeChange still refuses an unknown classification before any write", async () => {
    const store = p6Store()
    const bad = {
      firmId: "firmA",
      sourceModule: "d4-2",
      classification: "nope" as never,
      payload: {},
      proposedBy: "partner1",
    }
    expect(() => proposeChange(bad)).toThrow(/classification/)
    expect(() => proposeChange(bad, store)).toThrow(/classification/)
    expect(await store.listVersions("firmA")).toEqual([])
  })
})
