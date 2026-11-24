/**
 * L16.3 — one master write path (v19 L5561–L5594, L17.5 L7051–L7086, G-3 L8488).
 * These tests are red on 8271124d: the canonical module does not exist, and the
 * table statements still live in platform/p6/masterStore.ts.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { InMemoryMasterStore, type CommitVersionInput, type MasterStore, type PersistedProposal } from "@/platform/p6/masterStore"
import { applyChange, approveProposal, proposeChange, rollbackMaster, type ApprovalActor } from "@/platform/p6/proposeChange"
import {
  masterWriteAuditLog,
  masterWriteViolations,
  scanP6MasterWriters,
  writeMaster,
} from "@/platform/p6/masterWrite"

const PARTNER: ApprovalActor = { actorId: "partner_b", kind: "partner", role: "partner" }

function store(): MasterStore {
  return new InMemoryMasterStore({ role: "p6_service" })
}

function proposal(over: Partial<PersistedProposal> = {}): PersistedProposal {
  return {
    id: over.id ?? "prop-forged",
    firmId: "firmA",
    sourceModule: "15",
    classification: "confidential",
    changeClass: "substantive",
    requestedClass: "substantive",
    partition: "mutable",
    entryKey: "clause.nda",
    payload: { wording: "keep it secret" },
    proposedBy: "learner-1",
    status: "applied",
    decidedBy: "partner_b",
    decidedKind: "partner",
    decidedRole: "partner",
    declassify: false,
    payloadHash: "hash",
    ...over,
  }
}

function command(row: PersistedProposal, author: { authorId: string; authorKind: "partner" | "system" }): CommitVersionInput {
  const before = { entries: {} }
  const after = {
    entries: {
      [row.entryKey]: {
        partition: "mutable" as const,
        key: row.entryKey,
        body: row.payload,
        classification: row.classification,
      },
    },
  }
  return {
    firmId: row.firmId,
    proposalId: row.id,
    action: "apply",
    diff: { key: row.entryKey, partition: "mutable", before, after },
    snapshot: after,
    authorId: author.authorId,
    authorKind: author.authorKind,
    restoredFromVersionId: null,
    classification: row.classification,
    proposal: row,
    expectedBaseVersionId: null,
  }
}

function countingSession() {
  let commits = 0
  let gate: Promise<void> = Promise.resolve()
  return {
    commits: () => commits,
    session: {
      async allowDeclassify() {},
      async persistVersion(input: CommitVersionInput) {
        const previous = gate
        let release!: () => void
        gate = new Promise<void>((resolve) => {
          release = resolve
        })
        await previous
        try {
          commits += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
          return { committed: true as const, versionId: `v-${input.proposalId}-${commits}` }
        } finally {
          release()
        }
      },
    },
  }
}

describe("P6 consolidation — one master writer", () => {
  it("applyChange and rollbackMaster route through the canonical writer and are audited", async () => {
    const memory = store()
    const before = masterWriteAuditLog().length
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.audit",
        payload: { wording: "audited clause" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(pending.id, PARTNER, memory)
    const applied = await applyChange(pending.id, memory)
    const rolled = await rollbackMaster({ firmId: "firmA", toVersionId: applied.versionId, actor: PARTNER }, memory)
    const audit = masterWriteAuditLog().slice(before)
    expect(audit.map((row) => row.action)).toEqual(["apply", "rollback"])
    expect(audit[0]).toMatchObject({
      proposalId: pending.id,
      actorId: "partner_b",
      versionId: applied.versionId,
      outcome: "committed",
      firmId: "firmA",
    })
    expect(audit[1]).toMatchObject({
      action: "rollback",
      proposalId: null,
      actorId: "partner_b",
      versionId: rolled.versionId,
      outcome: "committed",
    })
    const proposeSource = readFileSync("platform/p6/proposeChange.ts", "utf8")
    const storeSource = readFileSync("platform/p6/masterStore.ts", "utf8")
    expect(proposeSource).not.toMatch(/\.commitVersion\s*\(/)
    expect(storeSource).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:[\w."]+\s*\.\s*)?["']?master_(?:knowledge|versions)\b/i)
    expect(storeSource).not.toMatch(/\.commitVersion\s*\(/)
    expect(storeSource).not.toMatch(/executeMasterTableWrite\s*\(/)
    expect(storeSource).toMatch(/guardedWrite\(/)
    const writerSource = readFileSync("platform/p6/masterWrite.ts", "utf8")
    expect(writerSource).not.toMatch(/export async function executeMasterTableWrite/)
  })

  it("an unapproved write refuses and does not commit", async () => {
    const counter = countingSession()
    const row = proposal({
      id: "prop-unapproved",
      changeClass: "cosmetic",
      requestedClass: "cosmetic",
      decidedBy: null,
      decidedKind: null,
      decidedRole: null,
      status: "pending",
    })
    await expect(writeMaster(command(row, { authorId: "p6", authorKind: "system" }), counter.session, { declassify: false })).rejects.toThrow(
      /partner approval/,
    )
    expect(counter.commits()).toBe(0)
    expect(masterWriteAuditLog().some((entry) => entry.proposalId === "prop-unapproved")).toBe(false)
  })

  it("an actor mismatch refuses, including a case-folded approver", async () => {
    const counter = countingSession()
    const row = proposal({
      id: "prop-mismatch",
      proposedBy: "partner_a",
      decidedBy: "Partner_A",
      status: "applied",
    })
    await expect(writeMaster(command(row, { authorId: "Partner_A", authorKind: "partner" }), counter.session, { declassify: false })).rejects.toThrow(
      /approver must differ from proposer/,
    )
    expect(counter.commits()).toBe(0)
  })

  it("a concurrent double-apply applies once", async () => {
    const counter = countingSession()
    const row = proposal({ id: "prop-race" })
    const input = command(row, { authorId: "partner_b", authorKind: "partner" })
    const raced = await Promise.allSettled([
      writeMaster(input, counter.session, { declassify: false }),
      writeMaster(input, counter.session, { declassify: false }),
    ])
    expect(raced.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(raced.filter((item) => item.status === "rejected")).toHaveLength(1)
    expect(counter.commits()).toBe(1)

    const memory = store()
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.once",
        payload: { wording: "once" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(pending.id, PARTNER, memory)
    const throughStore = await Promise.allSettled([applyChange(pending.id, memory), applyChange(pending.id, memory)])
    expect(throughStore.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect((await memory.listVersions("firmA")).filter((version) => version.proposalId === pending.id)).toHaveLength(1)
  })

  it("the source scan passes on this tree and fails on a planted second writer", () => {
    expect(scanP6MasterWriters()).toEqual([])
    expect(
      masterWriteViolations([
        {
          path: "platform/p6/sneakInsert.ts",
          source: "export const q = `INSERT INTO master_knowledge (firm_id) VALUES ('a')`\n",
        },
      ]),
    ).toEqual(["platform/p6/sneakInsert.ts"])
    expect(
      masterWriteViolations([
        {
          path: "platform/p6/sneakUpdate.ts",
          source: 'export const q = `UPDATE "public"."master_versions" SET author_id = \'forged\'`\n',
        },
      ]),
    ).toEqual(["platform/p6/sneakUpdate.ts"])
    expect(
      masterWriteViolations([
        { path: "platform/p6/sneakCall.ts", source: "export async function sneak(tx) { return tx.commitVersion(input) }\n" },
      ]),
    ).toEqual(["platform/p6/sneakCall.ts"])
    expect(
      masterWriteViolations([
        { path: "platform/p6/sneakDelegate.ts", source: "export async function sneak(client) { return executeMasterTableWrite(client, input, id) }\n" },
      ]),
    ).toEqual(["platform/p6/sneakDelegate.ts"])
    expect(
      masterWriteViolations([
        {
          path: "platform/p6/sneakCollection.ts",
          source: "export async function sneak(db) { return db.collection('master_versions').doc('a').set({ snapshot: {} }) }\n",
        },
      ]),
    ).toEqual(["platform/p6/sneakCollection.ts"])
    expect(
      masterWriteViolations([
        { path: "platform/p6/masterWrite.ts", source: "export const q = `INSERT INTO master_knowledge (firm_id) VALUES ('a')`\n" },
      ]),
    ).toEqual([])
    expect(masterWriteViolations([{ path: "platform/p6/note.ts", source: "export const label = 'change_proposals'\n" }])).toEqual([])
  })

  it("reads a pre-existing file once and does not follow a symlink that replaces a path", () => {
    const root = mkdtempSync(join(tmpdir(), "p6-scan-"))
    const dir = join(root, "platform", "p6")
    const hidden = join(root, "hidden")
    mkdirSync(dir, { recursive: true })
    mkdirSync(hidden)
    const preexisting = join(dir, "already.ts")
    const body = "export const q = `INSERT INTO master_knowledge (firm_id) VALUES ('kept')`\n"
    writeFileSync(preexisting, body)
    const outside = join(root, "outside.ts")
    writeFileSync(outside, "export const q = `INSERT INTO master_versions (version_id) VALUES ('via-link')`\n")
    symlinkSync(outside, join(dir, "linked.ts"))
    writeFileSync(join(hidden, "secret.ts"), "export const q = `UPDATE master_knowledge SET snapshot = '{}'`\n")
    symlinkSync(hidden, join(dir, "alias"))
    try {
      const first = scanP6MasterWriters(root)
      const second = scanP6MasterWriters(root)
      expect(first).toEqual(["platform/p6/already.ts"])
      expect(second).toEqual(first)
      expect(readFileSync(preexisting, "utf8")).toBe(body)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a public store or session commit of a pending substantive proposal writes nothing", async () => {
    const memory = new InMemoryMasterStore({ role: "p6_service" })
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.public",
        payload: { wording: "still pending" },
        proposedBy: "learner-1",
      },
      memory,
    )
    const input = {
      firmId: pending.firmId,
      proposalId: pending.id,
      action: "apply" as const,
      diff: { key: pending.entryKey, partition: "mutable" as const, before: { entries: {} }, after: { entries: {} } },
      snapshot: { entries: {} },
      authorId: "partner_b",
      authorKind: "partner" as const,
      restoredFromVersionId: null,
      classification: "confidential",
      proposal: pending,
      expectedBaseVersionId: null,
    }
    const auditBefore = masterWriteAuditLog().length
    await expect(memory.commitVersion(input)).rejects.toThrow(/substantive proposal requires partner approval/)
    await memory.runExclusive(async (tx) => {
      await expect(tx.commitVersion(input)).rejects.toThrow(/substantive proposal requires partner approval/)
    })
    expect(await memory.listVersions("firmA")).toEqual([])
    expect((await memory.getProposal(pending.id))?.status).toBe("pending")
    expect(masterWriteAuditLog().length).toBe(auditBefore)
  })

  it("a failed COMMIT drops the ledger and the audit so the same proposal can apply", async () => {
    const memory = new InMemoryMasterStore({ role: "p6_service", failCommit: "commit" })
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.retry",
        payload: { wording: "retry me" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(pending.id, PARTNER, memory)
    const auditBefore = masterWriteAuditLog().length
    await expect(applyChange(pending.id, memory)).rejects.toThrow(/did not commit/)
    expect(await memory.listVersions("firmA")).toEqual([])
    expect((await memory.getProposal(pending.id))?.status).toBe("approved")
    expect(masterWriteAuditLog().slice(auditBefore)).toEqual([])
    const applied = await applyChange(pending.id, memory)
    expect(applied.masterWritten).toBe(true)
    expect(await memory.listVersions("firmA")).toHaveLength(1)
    expect(masterWriteAuditLog().slice(auditBefore).map((row) => row.proposalId)).toEqual([pending.id])
  })

  it("the source scan reads the same extensions as the repository guard, including a planted non-TS writer", () => {
    const root = mkdtempSync(join(tmpdir(), "p6-ext-"))
    const dir = join(root, "platform", "p6")
    mkdirSync(dir, { recursive: true })
    const insert = "INSERT INTO master_versions (id) VALUES ('x')\n"
    writeFileSync(join(dir, "sneakInsert.js"), `export const q = \`${insert}\``)
    writeFileSync(join(dir, "sneakInsert.py"), `q = """${insert}"""\n`)
    writeFileSync(join(dir, "sneakInsert.sql"), insert)
    writeFileSync(join(dir, "note.md"), insert)
    try {
      expect(scanP6MasterWriters(root).sort()).toEqual([
        "platform/p6/sneakInsert.js",
        "platform/p6/sneakInsert.py",
        "platform/p6/sneakInsert.sql",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
