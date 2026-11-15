/**
 * Gate G-3 proofs (Layer 18 §10; L17.5). In-memory store: no live database.
 * masterWritten is true only after a committed, readable version row.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { FEATURE_FLAGS } from "@/lib/foundation-data"
import { assertLearnersStopped, learnersMayRun } from "@/platform/p6/learners"
import { InMemoryMasterStore, normalizeActorKey, type MasterStore, type PersistedProposal } from "@/platform/p6/masterStore"
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

/** Comments are not DDL. A trigger or grant that exists only after `--` or inside a block comment is absent. */
function stripSqlComments(sql: string): string {
  let out = ""
  let i = 0
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i)
      i = nl === -1 ? sql.length : nl
      continue
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    if (sql[i] === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2
          continue
        }
        if (sql[j] === "'") {
          j += 1
          break
        }
        j += 1
      }
      out += sql.slice(i, j)
      i = j
      continue
    }
    out += sql[i]
    i += 1
  }
  return out
}

/** FA-Q07-TEST-007. A grant to any role but p6_service is a finding, including a quoted role. */
export function masterDdlFindings(sql: string): string[] {
  const source = stripSqlComments(sql)
  const findings: string[] = []
  const grants = source.matchAll(/GRANT\s+[\s\S]*?\sTO\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1\s*;/gi)
  for (const grant of grants) {
    if (grant[2] !== "p6_service") findings.push(grant[2])
  }
  for (const table of ["change_proposals", "master_versions", "master_knowledge"]) {
    if (!new RegExp(`BEFORE DELETE ON public\\.${table}\\b`).test(source)) findings.push(`${table} delete`)
    if (!new RegExp(`BEFORE TRUNCATE ON public\\.${table}[\\s\\S]*?FOR EACH STATEMENT`).test(source)) {
      findings.push(`${table} truncate`)
    }
  }
  if (!/master_versions_one_proposal/.test(source)) findings.push("one proposal")
  if (!/approved proposal payload is frozen/.test(source)) findings.push("frozen payload")
  // One statement ends at its own semicolon. A later DROP TRIGGER must not count as this trigger.
  const statements = [...source.matchAll(/CREATE\s+TRIGGER\b[\s\S]*?;/gi)].map((hit) => hit[0])
  const writers = [
    { name: "change_proposals_p6_writer", table: "change_proposals", verbs: ["INSERT", "UPDATE"] },
    { name: "master_knowledge_p6_writer", table: "master_knowledge", verbs: ["INSERT", "UPDATE"] },
    { name: "master_versions_p6_writer", table: "master_versions", verbs: ["INSERT"] },
  ]
  for (const writer of writers) {
    const statement = statements.find((item) => new RegExp(`CREATE\\s+TRIGGER\\s+${writer.name}\\b`, "i").test(item))
    const onOwnTable = statement !== undefined && new RegExp(`\\bON\\s+public\\.${writer.table}\\b`, "i").test(statement)
    const callsWriter = statement !== undefined && /p6_refuse_non_p6_writer\s*\(/.test(statement)
    if (!statement || !onOwnTable || !callsWriter) {
      findings.push(writer.name)
      continue
    }
    for (const verb of writer.verbs) {
      if (!new RegExp(`\\b${verb}\\b`, "i").test(statement)) findings.push(`${writer.name} ${verb}`)
    }
  }
  const transition = statements.find((item) => /CREATE\s+TRIGGER\s+change_proposals_status_transition\b/i.test(item))
  const transitionOk =
    transition !== undefined &&
    /\bON\s+public\.change_proposals\b/i.test(transition) &&
    /p6_enforce_proposal_transition\s*\(/.test(transition) &&
    /\bINSERT\b/i.test(transition) &&
    /\bUPDATE\b/i.test(transition)
  if (!transitionOk) findings.push("change_proposals_status_transition")
  return findings
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
    const seed = await proposeChange(
      { ...substantive(), entryKey: "clause.order", payload: { note: "b  a" } },
      store,
    )
    await approveProposal(seed.id, PARTNER, store)
    await applyChange(seed.id, store)
    const pending = await proposeChange(
      { ...cosmetic(), classification: "confidential", payload: { note: "b a" } },
      store,
    )
    expect(pending.changeClass).toBe("cosmetic")
    const applied = await applyChange(pending.id, store)
    expect(applied.masterWritten).toBe(true)
    expect(applied.diff.after.entries["clause.order"]?.body).toEqual({ note: "b a" })
    const smuggled = await proposeChange(
      { ...cosmetic(), changeClass: "cosmetic", entryKey: "clause.smuggle", payload: { wording: "smuggled clause" } },
      store,
    )
    expect(smuggled.changeClass).toBe("substantive")
    await expect(applyChange(smuggled.id, store)).rejects.toThrow(/partner/)
    await expect(
      proposeChange({ ...substantive(), partition: "immutable", entryKey: "citation_protocol" }, store),
    ).rejects.toThrow(/immutable/)
  })

  it("G3-learners: learners stay off until G-3 has passed and the flag is on", () => {
    const ddl = readFileSync("postgres/ddl/010_p6_learners_flag.sql", "utf8")
    expect(ddl).toMatch(/\('LEARNERS_ENABLED','[^']*',false,'L17_5'\)/)
    expect(readFileSync("postgres/ddl/002_platform.sql", "utf8")).not.toMatch(/LEARNERS_ENABLED/)
    expect(FEATURE_FLAGS.find((flag) => flag.flag === "LEARNERS_ENABLED")?.defaultEnabled).toBe(false)
    expect(learnersMayRun({ g3Passed: false, learnersFlag: false })).toBe(false)
    expect(learnersMayRun({ g3Passed: false, learnersFlag: true })).toBe(false)
    expect(learnersMayRun({ g3Passed: true, learnersFlag: false })).toBe(false)
    expect(() => assertLearnersStopped({ g3Passed: false, learnersFlag: true })).toThrow(/learners remain off until G3 passes/)
    expect(() => assertLearnersStopped({ g3Passed: true, learnersFlag: false })).toThrow(/learners remain off until G3 passes/)
    expect(learnersMayRun({ g3Passed: true, learnersFlag: true })).toBe(true)
  })

  it("FA-Q07-APPLY-001: concurrent applies keep every committed change and one proposal yields one version", async () => {
    const store = p6Store()
    const first = await proposeChange(substantive("clause.one"), store)
    const second = await proposeChange(substantive("clause.two"), store)
    await approveProposal(first.id, PARTNER, store)
    await approveProposal(second.id, PARTNER, store)
    const applied = await Promise.all([applyChange(first.id, store), applyChange(second.id, store)])
    expect(applied.every((row) => row.masterWritten)).toBe(true)
    const head = await store.currentSnapshot("firmA")
    expect(head.entries["clause.one"]?.body).toEqual(substantive("clause.one").payload)
    expect(head.entries["clause.two"]?.body).toEqual(substantive("clause.two").payload)

    const again = await proposeChange(substantive("clause.same"), store)
    await approveProposal(again.id, PARTNER, store)
    const raced = await Promise.allSettled([applyChange(again.id, store), applyChange(again.id, store)])
    expect(raced.filter((row) => row.status === "fulfilled")).toHaveLength(1)
    const versions = await store.listVersions("firmA")
    expect(versions.filter((row) => row.proposalId === again.id)).toHaveLength(1)
  })

  it("FA-Q07-APPROVAL-002: caller changeClass cannot make a substantive diff cosmetic", async () => {
    const store = p6Store()
    const bypasses = [
      { text: "The receiving party shall keep the information secret." },
      { meta: { wording: "nested clause text" } },
      { Wording: "capitalised key still changes the clause" },
      "a bare string is a clause",
    ]
    for (const payload of bypasses) {
      const pending = await proposeChange(
        { ...cosmetic(), entryKey: `clause.bypass.${JSON.stringify(payload)}`, payload, changeClass: "cosmetic" },
        store,
      )
      expect(pending.changeClass).toBe("substantive")
      await expect(applyChange(pending.id, store)).rejects.toThrow(/partner approval/)
    }
    const seeded = await proposeChange(substantive("clause.format"), store)
    await approveProposal(seeded.id, PARTNER, store)
    await applyChange(seeded.id, store)
    const formatOnly = await proposeChange(
      {
        ...cosmetic(),
        entryKey: "clause.format",
        classification: "confidential",
        payload: { wording: "The   receiving   party   shall   keep   the   information   secret." },
        changeClass: "cosmetic",
      },
      store,
    )
    expect(formatOnly.changeClass).toBe("cosmetic")
    const applied = await applyChange(formatOnly.id, store)
    expect(applied.masterWritten).toBe(true)
    const forced = await proposeChange(
      {
        ...cosmetic(),
        entryKey: "clause.format",
        classification: "confidential",
        payload: { wording: "The receiving party shall keep the information secret." },
        changeClass: "substantive",
      },
      store,
    )
    expect(forced.changeClass).toBe("substantive")
    await expect(applyChange(forced.id, store)).rejects.toThrow(/partner approval/)
  })

  it("FA-Q07-DDL-003: the owner cannot delete or truncate master tables", () => {
    const sql = readFileSync("postgres/ddl/009_p6_master.sql", "utf8")
    expect(sql).toMatch(/DELETE and TRUNCATE are refused/)
    for (const table of ["change_proposals", "master_versions", "master_knowledge"]) {
      expect(sql).toMatch(new RegExp(`BEFORE DELETE ON public\\.${table}`))
      expect(sql).toMatch(new RegExp(`BEFORE TRUNCATE ON public\\.${table}[\\s\\S]*FOR EACH STATEMENT`))
    }
    expect(sql).toMatch(/master_versions_one_proposal/)
  })

  it("FA-Q07-CLASS-004: a downgrade needs partner declassify, and rollback keeps the higher class", async () => {
    const store = p6Store()
    const high = await proposeChange(substantive("clause.rank"), store)
    await approveProposal(high.id, PARTNER, store)
    const v1 = await applyChange(high.id, store)
    expect(await store.currentClassification("firmA")).toBe("confidential")
    const down = await proposeChange(
      { ...substantive("clause.rank"), classification: "public", payload: { wording: "published text" } },
      store,
    )
    await approveProposal(down.id, PARTNER, store)
    await expect(applyChange(down.id, store)).rejects.toThrow(/declassify/)
    expect(await store.currentClassification("firmA")).toBe("confidential")
    const allowed = await proposeChange(
      { ...substantive("clause.rank"), classification: "public", payload: { wording: "published text" } },
      store,
    )
    await approveProposal(allowed.id, { ...PARTNER, actorId: "partner_b", declassify: true }, store)
    await applyChange(allowed.id, store)
    expect(await store.currentClassification("firmA")).toBe("public")
    const raised = await proposeChange(
      { ...substantive("clause.rank"), classification: "privileged", payload: { wording: "counsel only" } },
      store,
    )
    await approveProposal(raised.id, { actorId: "partner_c", kind: "partner", role: "partner" }, store)
    await applyChange(raised.id, store)
    const rolled = await rollbackMaster({ firmId: "firmA", toVersionId: v1.versionId, actor: PARTNER }, store)
    expect(rolled.masterWritten).toBe(true)
    expect(await store.currentClassification("firmA")).toBe("privileged")
    const dropped = await rollbackMaster(
      {
        firmId: "firmA",
        toVersionId: v1.versionId,
        actor: { actorId: "partner_c", kind: "partner", role: "partner", declassify: true },
      },
      store,
    )
    expect(dropped.masterWritten).toBe(true)
    expect(await store.currentClassification("firmA")).toBe("confidential")
  })

  it("FA-Q07-ACTOR-006: the proposer cannot approve their own proposal", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive(), store)
    await expect(
      approveProposal(pending.id, { actorId: "learner-1", kind: "partner", role: "partner" }, store),
    ).rejects.toThrow(/differ from proposer/)
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
  })

  it("FA-Q07-R2-006: spacing or case does not make the proposer a different approver", async () => {
    const store = p6Store()
    const pending = await proposeChange({ ...substantive(), proposedBy: "partner_a" }, store)
    await expect(
      approveProposal(pending.id, { actorId: "partner_a ", kind: "partner", role: "partner" }, store),
    ).rejects.toThrow(/differ from proposer/)
    await expect(
      approveProposal(pending.id, { actorId: "PARTNER_A", kind: "partner", role: "partner" }, store),
    ).rejects.toThrow(/differ from proposer/)
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
  })

  it("FA-Q07-R2-006: saveProposal cannot mark a pending proposal approved", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.save"), store)
    await expect(
      store.saveProposal({
        ...pending,
        status: "approved",
        decidedBy: "partner_a",
        decidedKind: "partner",
        decidedRole: "partner",
      }),
    ).rejects.toThrow(/pending/)
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
  })

  it("FA-Q07-R2-006: insertProposal refuses approved and other terminal statuses", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.insert"), store)
    const base = {
      ...pending,
      id: "00000000-0000-4000-8000-000000000099",
      decidedBy: null,
      decidedKind: null,
      decidedRole: null,
      declassify: false,
    }
    for (const status of ["approved", "applied", "rejected"] as const) {
      await expect(store.insertProposal({ ...base, status })).rejects.toThrow(/new proposals are pending/)
      expect(await store.getProposal(base.id)).toBeNull()
    }
    await expect(
      store.insertProposal({
        ...base,
        status: "pending",
        decidedBy: "partner_b",
        decidedKind: "partner",
        decidedRole: "partner",
      }),
    ).rejects.toThrow(/new proposals are pending/)
    expect(await store.getProposal(base.id)).toBeNull()
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
  })

  it("FA-Q07-R2-006: proposedBy is immutable", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.proposer"), store)
    await expect(store.saveProposal({ ...pending, proposedBy: "other-actor" })).rejects.toThrow(/proposedBy is immutable/)
    expect((await store.getProposal(pending.id))?.proposedBy).toBe("learner-1")
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
  })

  it("MEM-252-005: a duplicate insert cannot rewrite proposedBy", async () => {
    const store = p6Store()
    const pending = await proposeChange({ ...substantive("clause.dup"), proposedBy: "partner_a" }, store)
    await expect(store.insertProposal({ ...pending, proposedBy: "other-actor" })).rejects.toThrow(
      new RegExp(`proposal id already exists: ${pending.id}`),
    )
    expect((await store.getProposal(pending.id))?.proposedBy).toBe("partner_a")
    await expect(
      approveProposal(pending.id, { actorId: "partner_a", kind: "partner", role: "partner" }, store),
    ).rejects.toThrow(/differ from proposer/)
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
  })

  it("MEM-252-005: commitVersion cannot rewrite proposedBy", async () => {
    const store = p6Store()
    const pending = await proposeChange({ ...substantive("clause.commit-by"), proposedBy: "partner_a" }, store)
    await expect(
      store.commitVersion({
        firmId: pending.firmId,
        proposalId: pending.id,
        action: "apply",
        diff: { key: pending.entryKey, partition: "mutable", before: { entries: {} }, after: { entries: {} } },
        snapshot: { entries: {} },
        authorId: "partner_b",
        authorKind: "partner",
        restoredFromVersionId: null,
        classification: "confidential",
        proposal: { ...pending, proposedBy: "other-actor" },
        expectedBaseVersionId: null,
      }),
    ).rejects.toThrow(/proposedBy is immutable/)
    expect((await store.getProposal(pending.id))?.proposedBy).toBe("partner_a")
    expect((await store.getProposal(pending.id))?.payload).toEqual(pending.payload)
    expect(await store.listVersions("firmA")).toEqual([])
    await expect(
      approveProposal(pending.id, { actorId: "partner_a", kind: "partner", role: "partner" }, store),
    ).rejects.toThrow(/differ from proposer/)
  })

  it("MEM-252-005: commitVersion cannot swap the payload", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.commit-payload"), store)
    await expect(
      store.commitVersion({
        firmId: pending.firmId,
        proposalId: pending.id,
        action: "apply",
        diff: { key: pending.entryKey, partition: "mutable", before: { entries: {} }, after: { entries: {} } },
        snapshot: { entries: {} },
        authorId: "partner_b",
        authorKind: "partner",
        restoredFromVersionId: null,
        classification: "confidential",
        proposal: { ...pending, payload: { wording: "swapped" } },
        expectedBaseVersionId: null,
      }),
    ).rejects.toThrow(/approved proposal payload is frozen/)
    expect((await store.getProposal(pending.id))?.payload).toEqual(pending.payload)
    expect(await store.listVersions("firmA")).toEqual([])
  })

  it("MEM-252-005: cas approved to applied cannot rewrite proposedBy", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.cas-by"), store)
    await approveProposal(pending.id, PARTNER, store)
    const approved = await store.getProposal(pending.id)
    await store.runExclusive(async (tx) => {
      await expect(
        tx.casProposal({ ...approved!, status: "applied", proposedBy: "other-actor" }, "approved"),
      ).rejects.toThrow(/proposedBy is immutable/)
    })
    const kept = await store.getProposal(pending.id)
    expect(kept?.proposedBy).toBe("learner-1")
    expect(kept?.status).toBe("approved")
  })

  function versionOf(row: PersistedProposal, proposal: PersistedProposal) {
    return {
      firmId: row.firmId,
      proposalId: proposal.id,
      action: "apply" as const,
      diff: { key: row.entryKey, partition: "mutable" as const, before: { entries: {} }, after: { entries: {} } },
      snapshot: { entries: {} },
      authorId: "partner_b",
      authorKind: "partner" as const,
      restoredFromVersionId: null,
      classification: "confidential",
      proposal,
      expectedBaseVersionId: null,
    }
  }

  it("MEM-252-R3-001: save, cas, and commit freeze every trigger-frozen column", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.freeze-cols"), store)
    const swaps: Array<[keyof PersistedProposal, PersistedProposal[keyof PersistedProposal]]> = [
      ["changeClass", "cosmetic"],
      ["requestedClass", "cosmetic"],
      ["firmId", "firmB"],
      ["entryKey", "clause.other"],
      ["classification", "public"],
      ["sourceModule", "other-module"],
      ["partition", "immutable"],
    ]
    for (const [field, value] of swaps) {
      await expect(store.saveProposal({ ...pending, [field]: value })).rejects.toThrow(/frozen/)
      expect((await store.getProposal(pending.id))?.[field]).toBe(pending[field])
    }
    await approveProposal(pending.id, PARTNER, store)
    const approved = await store.getProposal(pending.id)
    for (const [field, value] of swaps) {
      await store.runExclusive(async (tx) => {
        await expect(
          tx.casProposal({ ...approved!, status: "applied", [field]: value }, "approved"),
        ).rejects.toThrow(/frozen|immutable|transition is refused/)
      })
      const kept = await store.getProposal(pending.id)
      expect(kept?.[field]).toBe(approved?.[field])
      expect(kept?.status).toBe("approved")
    }
    const fresh = p6Store()
    const row = await proposeChange(substantive("clause.commit-cols"), fresh)
    for (const [field, value] of swaps) {
      await expect(fresh.commitVersion(versionOf(row, { ...row, [field]: value }))).rejects.toThrow(
        /frozen|immutable/,
      )
      expect((await fresh.getProposal(row.id))?.[field]).toBe(row[field])
      expect(await fresh.listVersions("firmA")).toEqual([])
    }
  })

  it("MEM-252-R3-001: commitVersion refuses an unknown proposal id", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.unknown"), store)
    const missing = { ...pending, id: "00000000-0000-4000-8000-0000000000aa" }
    await expect(store.commitVersion(versionOf(pending, missing))).rejects.toThrow(/proposal not found/)
    expect(await store.getProposal(missing.id)).toBeNull()
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
    expect(await store.listVersions("firmA")).toEqual([])
  })

  it("MEM-252-R3-001: commitVersion refuses changed decided fields", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.decided"), store)
    const stamps: Array<Partial<PersistedProposal>> = [
      { decidedBy: "partner_b" },
      { decidedKind: "system" },
      { decidedRole: "system" },
    ]
    for (const stamp of stamps) {
      await expect(store.commitVersion(versionOf(pending, { ...pending, ...stamp }))).rejects.toThrow(
        /approval is not a direct status change/,
      )
      const kept = await store.getProposal(pending.id)
      expect(kept?.decidedBy).toBeNull()
      expect(kept?.decidedKind).toBeNull()
      expect(kept?.decidedRole).toBeNull()
      expect(kept?.status).toBe("pending")
      expect(await store.listVersions("firmA")).toEqual([])
    }
  })

  it("PARITY-252-R3-002: actor keys outside ASCII are empty after folding", () => {
    const pairs = ["\u{16EA0}", "\u{16EBB}", "\u{A7CE}", "\u{A7CF}", "\u{A7D2}", "\u{A7D3}"]
    for (const value of pairs) expect(normalizeActorKey(value)).toBe("")
    expect(normalizeActorKey("partner_\u{16EA0}")).toBe("")
    expect(normalizeActorKey("Partner_A")).toBe("partner_a")
    expect(normalizeActorKey("straße")).toBe("strasse")
    expect(normalizeActorKey("a.b@firm")).toBe("a.b@firm")
    const sql = readFileSync("postgres/ddl/009_p6_master.sql", "utf8")
    const forward = readFileSync("postgres/ddl/011_p6_actor_key.sql", "utf8")
    const body = (text: string) => {
      const match = text.match(/CREATE OR REPLACE FUNCTION public\.p6_actor_key[\s\S]*?\$fn\$;/)
      if (!match) throw new Error("p6_actor_key body missing")
      return match[0]
    }
    expect(sql).toMatch(/\^\[a-z0-9._@-\]\+\$/)
    expect(body(forward)).toBe(body(sql))
  })

  it("PARITY-252-R3-002: a Unicode 16 case pair cannot approve, including a different ASCII partner", async () => {
    const store = p6Store()
    const pending = await proposeChange({ ...substantive("clause.unicode"), proposedBy: "\u{16EA0}" }, store)
    await expect(
      approveProposal(pending.id, { actorId: "\u{16EBB}", kind: "partner", role: "partner" }, store),
    ).rejects.toThrow(/substantive proposal requires partner approval/)
    await expect(
      approveProposal(pending.id, { actorId: "partner_b", kind: "partner", role: "partner" }, store),
    ).rejects.toThrow(/substantive proposal requires partner approval/)
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
  })

  it("TEST-258-002: space, plus, and colon are not actor keys", () => {
    expect(normalizeActorKey("Partner B")).toBe("")
    expect(normalizeActorKey("partner+1@x")).toBe("")
    expect(normalizeActorKey("partner:1")).toBe("")
  })

  it("TEST-258-002: commitVersion refuses a declassify stamp or a status-only write", async () => {
    const store = p6Store()
    const row = await proposeChange(substantive("clause.commit-pin"), store)
    await expect(store.commitVersion(versionOf(row, { ...row, declassify: true }))).rejects.toThrow(
      /approval is not a direct status change/,
    )
    await expect(store.commitVersion(versionOf(row, { ...row, status: "applied" }))).rejects.toThrow(
      /proposal status transition is refused/,
    )
    expect((await store.getProposal(row.id))?.status).toBe("pending")
    expect((await store.getProposal(row.id))?.declassify).toBe(false)
    expect(await store.listVersions("firmA")).toEqual([])
  })

  it("MEM-258-004: commitVersion binds proposalId and firmId to the proposal", async () => {
    const store = p6Store()
    const row = await proposeChange(substantive("clause.bind"), store)
    const other = "00000000-0000-4000-8000-0000000000cc"
    await expect(store.commitVersion({ ...versionOf(row, row), proposalId: other })).rejects.toThrow(
      /commit is bound to the proposal/,
    )
    await expect(store.commitVersion({ ...versionOf(row, row), firmId: "firmB" })).rejects.toThrow(
      /commit is bound to the proposal/,
    )
    expect((await store.getProposal(row.id))?.firmId).toBe("firmA")
    expect((await store.getProposal(row.id))?.status).toBe("pending")
    expect(await store.listVersions("firmA")).toEqual([])
    expect(await store.listVersions("firmB")).toEqual([])
  })

  it("PARITY-258-005: U+0130 and U+1CCD6-U+1CCF9 are empty before lower", () => {
    expect(normalizeActorKey("\u0130")).toBe("")
    expect(normalizeActorKey("\u{1CCD6}")).toBe("")
    expect(normalizeActorKey("\u{1CCE0}")).toBe("")
    expect(normalizeActorKey("\u{1CCF9}")).toBe("")
    expect(normalizeActorKey("partner_\u{1CCD6}")).toBe("")
    expect(normalizeActorKey("straße")).toBe("strasse")
    const sql = readFileSync("postgres/ddl/009_p6_master.sql", "utf8")
    const body = sql.match(/CREATE OR REPLACE FUNCTION public\.p6_actor_key_next[\s\S]*?\$fn\$;/)?.[0] ?? ""
    const asciiAt = body.indexOf("[^[:ascii:]]")
    const lowerAt = body.indexOf("actor_key := lower")
    expect(asciiAt).toBeGreaterThan(-1)
    expect(lowerAt).toBeGreaterThan(asciiAt)
  })

  it("FA-Q07-R2-006: saveProposal cannot stamp partner approval fields", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.stamp"), store)
    await expect(
      store.saveProposal({
        ...pending,
        status: "pending",
        decidedBy: "partner_b",
        decidedKind: "partner",
        decidedRole: "partner",
        declassify: true,
      }),
    ).rejects.toThrow(/approval is not a direct status change/)
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
    expect((await store.getProposal(pending.id))?.decidedBy).toBeNull()
  })

  it("FA-Q07-R2-006: casProposal refuses a direct move into approved", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.cas"), store)
    const approved = {
      ...pending,
      status: "approved" as const,
      decidedBy: "partner_b",
      decidedKind: "partner" as const,
      decidedRole: "partner",
      declassify: true,
    }
    await store.runExclusive(async (tx) => {
      await expect(tx.casProposal(approved, "pending")).rejects.toThrow(/approval is not a direct status change/)
    })
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
    expect((await store.getProposal(pending.id))?.decidedBy).toBeNull()
    await expect(
      store.commitVersion({
        firmId: pending.firmId,
        proposalId: pending.id,
        action: "apply",
        diff: { key: pending.entryKey, partition: "mutable", before: { entries: {} }, after: { entries: {} } },
        snapshot: { entries: {} },
        authorId: "partner_b",
        authorKind: "partner",
        restoredFromVersionId: null,
        classification: "confidential",
        proposal: approved,
        expectedBaseVersionId: null,
      }),
    ).rejects.toThrow(/approval is not a direct status change/)
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
    expect(await store.listVersions("firmA")).toEqual([])
    await approveProposal(pending.id, PARTNER, store)
    const applied = await applyChange(pending.id, store)
    expect(applied.masterWritten).toBe(true)
    expect((await store.getProposal(pending.id))?.decidedBy).toBe("partner_a")
  })

  it("FA-Q07-R2-006: casProposal only follows the explicit transition table", async () => {
    const store = p6Store()
    const pending = await proposeChange(substantive("clause.transition"), store)
    await store.runExclusive(async (tx) => {
      await expect(
        tx.casProposal({ ...pending, status: "rejected" }, "pending"),
      ).rejects.toThrow(/proposal status transition is refused/)
      await expect(
        tx.casProposal(
          {
            ...pending,
            status: "applied",
            decidedBy: "partner_b",
            decidedKind: "partner",
            decidedRole: "partner",
          },
          "pending",
        ),
      ).rejects.toThrow(/approval is not a direct status change/)
      await expect(
        tx.casProposal(
          { ...pending, status: "applied", decidedBy: "p6", decidedKind: "system", decidedRole: "system" },
          "pending",
        ),
      ).rejects.toThrow(/proposal status transition is refused/)
    })
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
    await approveProposal(pending.id, PARTNER, store)
    const approved = await store.getProposal(pending.id)
    await store.runExclusive(async (tx) => {
      await expect(tx.casProposal({ ...approved!, status: "pending" }, "approved")).rejects.toThrow(
        /proposal status transition is refused/,
      )
    })
    expect((await store.getProposal(pending.id))?.status).toBe("approved")
    const applied = await applyChange(pending.id, store)
    expect(applied.masterWritten).toBe(true)
    const row = await store.getProposal(pending.id)
    await store.runExclusive(async (tx) => {
      await expect(
        tx.casProposal(
          { ...row!, status: "approved", decidedBy: "partner_b", decidedKind: "partner", decidedRole: "partner" },
          "applied",
        ),
      ).rejects.toThrow(/approval is not a direct status change/)
    })
    expect((await store.getProposal(pending.id))?.status).toBe("applied")
    const seed = await proposeChange(
      { ...substantive("clause.order"), payload: { order: ["b", "a"] } },
      store,
    )
    await approveProposal(seed.id, { actorId: "partner_b", kind: "partner", role: "partner" }, store)
    await applyChange(seed.id, store)
    const cosmeticPending = await proposeChange(
      { ...cosmetic(), classification: "confidential", payload: { order: ["b", " a"] } },
      store,
    )
    expect(cosmeticPending.changeClass).toBe("cosmetic")
    const cosmeticApplied = await applyChange(cosmeticPending.id, store)
    expect(cosmeticApplied.masterWritten).toBe(true)
    expect((await store.getProposal(cosmeticPending.id))?.decidedKind).toBe("system")
  })

  it("FA-Q07-R2-006: NFKC and default-ignorables do not split one actor", async () => {
    const store = p6Store()
    const pending = await proposeChange({ ...substantive("clause.actor"), proposedBy: "partner_a" }, store)
    const disguises = [
      "partner_a\u200D",
      "part\u200Cner_a",
      "partner_\u200Ba",
      "partner_a\u00AD",
      "\uFEFFpartner_a",
      "partner_a\uFE0E",
      "partner_\u202Ea",
      "\uFF50\uFF41\uFF52\uFF54\uFF4E\uFF45\uFF52\uFF3F\uFF41",
    ]
    for (const actorId of disguises) {
      await expect(
        approveProposal(pending.id, { actorId, kind: "partner", role: "partner" }, store),
      ).rejects.toThrow(/differ from proposer/)
    }
    expect((await store.getProposal(pending.id))?.status).toBe("pending")
    await expect(
      approveProposal(pending.id, { actorId: "\u200B\u200C\u200D\uFEFF", kind: "partner", role: "partner" }, store),
    ).rejects.toThrow(/partner approval/)
    const folded = await proposeChange({ ...substantive("clause.eszett"), proposedBy: "straße" }, store)
    await expect(
      approveProposal(folded.id, { actorId: "STRASSE", kind: "partner", role: "partner" }, store),
    ).rejects.toThrow(/differ from proposer/)
    expect((await store.getProposal(folded.id))?.status).toBe("pending")
    await approveProposal(pending.id, { actorId: "partner_b\u200D", kind: "partner", role: "partner" }, store)
    expect((await store.getProposal(pending.id))?.status).toBe("approved")
    expect((await store.getProposal(pending.id))?.decidedBy).toBe("partner_b\u200D")
  })

  it("FA-Q07-R2-006: the proposal transition table is enforced in the master DDL", () => {
    const sql = readFileSync("postgres/ddl/009_p6_master.sql", "utf8")
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.p6_actor_key/)
    expect(sql).toMatch(/normalize\([\s\S]*?NFKC/)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.p6_enforce_proposal_transition/)
    expect(sql).toMatch(/new proposals are pending/)
    expect(sql).toMatch(/approval is not a direct status change/)
    expect(sql).toMatch(/approver must differ from proposer/)
    expect(sql).toMatch(/proposal status transition is refused/)
    expect(sql).toMatch(
      /CREATE TRIGGER change_proposals_status_transition[\s\S]*?p6_enforce_proposal_transition\s*\(/,
    )
    expect(sql).toMatch(/decided_by IS NOT NULL/)
  })

  it("FA-Q07-DDL-008: LEARNERS_ENABLED is seeded in its own file, not in 002", () => {
    expect(readFileSync("postgres/ddl/002_platform.sql", "utf8")).not.toMatch(/LEARNERS_ENABLED/)
    expect(readFileSync("postgres/ddl/010_p6_learners_flag.sql", "utf8")).toMatch(
      /\('LEARNERS_ENABLED','[^']*',false,'L17_5'\)/,
    )
  })

  it("FA-Q07-DATA-009: an approved payload cannot be rewritten", () => {
    const sql = readFileSync("postgres/ddl/009_p6_master.sql", "utf8")
    expect(sql).toMatch(/approved proposal payload is frozen/)
    expect(sql).toMatch(/BEFORE UPDATE ON public\.change_proposals[\s\S]*p6_freeze_approved_payload/)
    expect(sql).toMatch(/payload_hash/)
  })

  it("FA-Q07-R2-DATA-009: a pending edit cannot be what the partner approves", async () => {
    const store = p6Store()
    const original = { wording: "The receiving party shall keep the information secret." }
    const pending = await proposeChange(substantive("clause.freeze"), store)
    const row = await store.getProposal(pending.id)
    expect(row?.payloadHash).toBeTruthy()
    await expect(
      store.saveProposal({ ...row!, payload: { wording: "swapped after the request" } }),
    ).rejects.toThrow(/frozen/)
    expect((await store.getProposal(pending.id))?.payload).toEqual(original)
    await approveProposal(pending.id, PARTNER, store)
    const applied = await applyChange(pending.id, store)
    expect(applied.masterWritten).toBe(true)
    expect(applied.diff.after.entries["clause.freeze"]?.body).toEqual(original)
    expect((await store.getProposal(pending.id))?.payloadHash).toBe(row?.payloadHash)
  })

  it("FA-Q07-R2-001: __proto__, constructor, and prototype do not auto-apply as cosmetic", async () => {
    const store = p6Store()
    const seed = await proposeChange(
      { ...substantive(), entryKey: "clause.proto", payload: { note: "b  a" } },
      store,
    )
    await approveProposal(seed.id, PARTNER, store)
    await applyChange(seed.id, store)
    const attacks = [
      JSON.parse('{"note":"b a","__proto__":{"smuggled":true}}'),
      JSON.parse('{"note":"b a","constructor":{"smuggled":true}}'),
      JSON.parse('{"note":"b a","prototype":{"smuggled":true}}'),
    ]
    for (const payload of attacks) {
      const pending = await proposeChange(
        {
          ...cosmetic(),
          entryKey: "clause.proto",
          classification: "confidential",
          payload,
          changeClass: "cosmetic",
        },
        store,
      )
      expect(pending.changeClass).toBe("substantive")
      await expect(applyChange(pending.id, store)).rejects.toThrow(/partner/)
    }
    const nestedSeed = await proposeChange(
      { ...substantive(), entryKey: "clause.nestedproto", payload: { note: "kept", box: {} } },
      store,
    )
    await approveProposal(nestedSeed.id, PARTNER, store)
    await applyChange(nestedSeed.id, store)
    const nested = await proposeChange(
      {
        ...cosmetic(),
        entryKey: "clause.nestedproto",
        classification: "confidential",
        payload: JSON.parse('{"note":"kept","box":{"__proto__":{"smuggled":true}}}'),
        changeClass: "cosmetic",
      },
      store,
    )
    expect(nested.changeClass).toBe("substantive")
    await expect(applyChange(nested.id, store)).rejects.toThrow(/partner/)
    const ordered = await proposeChange(
      { ...substantive(), entryKey: "clause.keyorder", payload: { b: "one", a: "two" } },
      store,
    )
    await approveProposal(ordered.id, PARTNER, store)
    await applyChange(ordered.id, store)
    const reordered = await proposeChange(
      {
        ...cosmetic(),
        entryKey: "clause.keyorder",
        classification: "confidential",
        payload: { a: "two", b: "one" },
        changeClass: "cosmetic",
      },
      store,
    )
    expect(reordered.changeClass).toBe("cosmetic")
    const applied = await applyChange(reordered.id, store)
    expect(applied.masterWritten).toBe(true)
  })

  it("FA-Q07-TEST-007: a quoted grant is caught, and dropping the owner triggers is a finding", () => {
    const sql = readFileSync("postgres/ddl/009_p6_master.sql", "utf8")
    expect(masterDdlFindings(`GRANT INSERT ON TABLE master_knowledge TO "evil_role";`)).toContain("evil_role")
    const removalStripped = sql.replace(
      /CREATE TRIGGER[\s\S]*?EXECUTE FUNCTION public\.p6_refuse_removal\(\);/g,
      "",
    )
    expect(masterDdlFindings(removalStripped).length).toBeGreaterThan(0)
    const writerStripped = sql.replace(
      /CREATE TRIGGER[\s\S]*?EXECUTE FUNCTION public\.p6_refuse_non_p6_writer\(\);/g,
      "",
    )
    expect(masterDdlFindings(writerStripped).length).toBeGreaterThan(0)
    expect(masterDdlFindings(sql)).toEqual([])
    expect(sql).toMatch(/disable or drop/i)
    const dropNamed = (source: string, name: string) => {
      const next = source.replace(new RegExp(`CREATE\\s+TRIGGER\\s+${name}\\b[\\s\\S]*?;`, "i"), "")
      expect(next).not.toBe(source)
      return next
    }
    const versionsGone = dropNamed(sql, "master_versions_p6_writer")
    expect(masterDdlFindings(versionsGone)).toContain("master_versions_p6_writer")
    const knowledgeGone = dropNamed(sql, "master_knowledge_p6_writer")
    expect(masterDdlFindings(knowledgeGone)).toContain("master_knowledge_p6_writer")
    const bothGone = dropNamed(versionsGone, "master_knowledge_p6_writer")
    const bothFindings = masterDdlFindings(bothGone)
    expect(bothFindings).toContain("master_versions_p6_writer")
    expect(bothFindings).toContain("master_knowledge_p6_writer")
    const transitionGone = dropNamed(sql, "change_proposals_status_transition")
    expect(masterDdlFindings(transitionGone)).toContain("change_proposals_status_transition")
    const commentedTrigger = sql.replace(
      "CREATE TRIGGER change_proposals_status_transition",
      "-- CREATE TRIGGER change_proposals_status_transition",
    )
    expect(commentedTrigger).not.toBe(sql)
    expect(masterDdlFindings(commentedTrigger)).toContain("change_proposals_status_transition")
    expect(masterDdlFindings(`-- GRANT INSERT ON TABLE master_knowledge TO evil_role;\n${sql}`)).toEqual([])
    expect(masterDdlFindings(`/* GRANT INSERT ON TABLE master_knowledge TO evil_role; */\n${sql}`)).toEqual([])
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
