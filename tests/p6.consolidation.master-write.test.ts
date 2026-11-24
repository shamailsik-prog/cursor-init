/**
 * L16.3 — one master write path (v19 L5561–L5594, L17.5 L7051–L7086, G-3 L8488).
 * These tests are red on 8271124d: the canonical module does not exist, and the
 * table statements still live in platform/p6/masterStore.ts.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  InMemoryMasterStore,
  type CommitVersionInput,
  type MasterSession,
  type MasterStore,
  type PersistedProposal,
} from "@/platform/p6/masterStore"
import { applyChange, approveProposal, proposeChange, rollbackMaster, type ApprovalActor } from "@/platform/p6/proposeChange"
import {
  masterWriteAuditLog,
  masterWriteViolations,
  nextSnapshot,
  scanP6MasterWriters,
  sealMasterSession,
  writeMaster,
} from "@/platform/p6/masterWrite"
import * as p6Index from "@/platform/p6"
import * as storeModule from "@/platform/p6/masterStore"

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

function countingSession(row: PersistedProposal) {
  let commits = 0
  let gate: Promise<void> = Promise.resolve()
  const session = {
    async getProposal(id: string) {
      return id === row.id ? row : null
    },
    async currentSnapshot() {
      return { entries: {} }
    },
    async currentClassification() {
      return "confidential" as const
    },
    async lockFirm() {
      return null
    },
    async getVersion() {
      return null
    },
    async assertCommitShape() {},
  }
  sealMasterSession(session, {
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
  })
  return { commits: () => commits, session }
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
    const row = proposal({
      id: "prop-unapproved",
      changeClass: "substantive",
      requestedClass: null,
      decidedBy: null,
      decidedKind: null,
      decidedRole: null,
      status: "pending",
    })
    const counter = countingSession(row)
    await expect(writeMaster(command(row, { authorId: "p6", authorKind: "system" }), counter.session, { declassify: false })).rejects.toThrow(
      /partner approval/,
    )
    expect(counter.commits()).toBe(0)
    expect(masterWriteAuditLog().some((entry) => entry.proposalId === "prop-unapproved")).toBe(false)
  })

  it("an actor mismatch refuses, including a case-folded approver", async () => {
    const row = proposal({
      id: "prop-mismatch",
      proposedBy: "partner_a",
      decidedBy: "Partner_A",
      status: "applied",
    })
    const counter = countingSession(row)
    await expect(writeMaster(command(row, { authorId: "Partner_A", authorKind: "partner" }), counter.session, { declassify: false })).rejects.toThrow(
      /approver must differ from proposer/,
    )
    expect(counter.commits()).toBe(0)
  })

  it("a concurrent double-apply applies once", async () => {
    const row = proposal({ id: "prop-race" })
    const counter = countingSession(row)
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
    await expect(memory.commitVersion(input)).rejects.toThrow(/partner approval|bound to the proposal/)
    await memory.runExclusive(async (tx) => {
      await expect(tx.commitVersion(input)).rejects.toThrow(/partner approval|bound to the proposal/)
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

  it("the source scan recurses and reads mjs, cjs, jsx, mts, and any master_ table", () => {
    const root = mkdtempSync(join(tmpdir(), "p6-more-"))
    const nested = join(root, "platform", "p6", "nested")
    mkdirSync(nested, { recursive: true })
    const plant = (name: string, table: string) => {
      writeFileSync(join(nested, name), `INSERT INTO ${table} (id) VALUES ('x')\n`)
    }
    plant("sneak.mjs", "master_audit")
    plant("sneak.cjs", "master_audit")
    plant("sneak.jsx", "master_audit")
    plant("sneak.mts", "master_audit")
    try {
      expect(scanP6MasterWriters(root).sort()).toEqual([
        "platform/p6/nested/sneak.cjs",
        "platform/p6/nested/sneak.jsx",
        "platform/p6/nested/sneak.mjs",
        "platform/p6/nested/sneak.mts",
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("a forged rollback, a pending substantive, and an unapproved snapshot are refused", async () => {
    const memory = store()
    const forged = {
      entries: {
        forged: {
          partition: "mutable" as const,
          key: "forged",
          body: { wording: "forged" },
          classification: "confidential" as const,
        },
      },
    }
    const rollback = {
      firmId: "firmA",
      proposalId: null,
      action: "rollback" as const,
      diff: { key: "*", partition: "mutable" as const, before: { entries: {} }, after: forged },
      snapshot: forged,
      authorId: "clerk_x",
      authorKind: "partner" as const,
      restoredFromVersionId: null,
      classification: "confidential",
      proposal: null,
      expectedBaseVersionId: null,
    }
    await expect(memory.commitVersion(rollback)).rejects.toThrow(/version not found/)
    await memory.runExclusive(async (tx) => {
      await expect(tx.commitVersion(rollback)).rejects.toThrow(/version not found/)
    })
    const pending = await memory.insertProposal({
      id: "00000000-0000-4000-8000-000000000271",
      firmId: "firmA",
      sourceModule: "15",
      classification: "confidential",
      changeClass: "substantive",
      requestedClass: null,
      partition: "mutable",
      entryKey: "clause.pending",
      payload: { wording: "stored" },
      proposedBy: "learner-1",
      status: "pending",
      decidedBy: null,
      decidedKind: null,
      decidedRole: null,
      declassify: false,
      payloadHash: "pending",
    })
    const current = await memory.currentSnapshot("firmA")
    const disguisedBefore = {
      entries: {
        [pending.entryKey]: {
          partition: "mutable" as const,
          key: pending.entryKey,
          body: pending.payload,
          classification: "confidential" as const,
        },
      },
    }
    const cosmeticLooking = {
      firmId: pending.firmId,
      proposalId: pending.id,
      action: "apply" as const,
      diff: { key: pending.entryKey, partition: "mutable" as const, before: disguisedBefore, after: forged },
      snapshot: forged,
      authorId: "p6",
      authorKind: "system" as const,
      restoredFromVersionId: null,
      classification: "confidential",
      proposal: pending,
      expectedBaseVersionId: null,
    }
    await expect(memory.commitVersion(cosmeticLooking)).rejects.toThrow(/bound to the proposal|partner approval/)
    await memory.runExclusive(async (tx) => {
      await expect(tx.commitVersion(cosmeticLooking)).rejects.toThrow(/bound to the proposal|partner approval/)
    })
    const approved = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.bound",
        payload: { wording: "approved text" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(approved.id, PARTNER, memory)
    const stored = await memory.getProposal(approved.id)
    await memory.runExclusive(async (tx) => {
      const current = await tx.currentSnapshot("firmA")
      const applied = { ...stored!, status: "applied" as const }
      expect(await tx.casProposal(applied, "approved")).toBe(true)
      await expect(
        tx.commitVersion({
          firmId: "firmA",
          proposalId: stored!.id,
          action: "apply",
          diff: { key: stored!.entryKey, partition: "mutable", before: current, after: forged },
          snapshot: forged,
          authorId: "partner_b",
          authorKind: "partner",
          restoredFromVersionId: null,
          classification: "confidential",
          proposal: applied,
          expectedBaseVersionId: await tx.lockFirm("firmA"),
        }),
      ).rejects.toThrow(/bound to the proposal/)
    })
    expect(await memory.listVersions("firmA")).toEqual([])
    const openRaw = (
      storeModule as {
        sessionForWrite?: (session: object) => {
          persistVersion?: (input: CommitVersionInput) => Promise<{ committed: boolean }>
        }
      }
    ).sessionForWrite
    await memory.runExclusive(async (tx) => {
      if (openRaw) {
        const written = await openRaw(tx).persistVersion?.(rollback)
        expect(written?.committed).toBe(false)
      }
    })
    expect(openRaw).toBeUndefined()
    expect("writeMaster" in p6Index).toBe(false)
  })

  it("a raw persist is not on the session, and a finished memory transaction throws", async () => {
    const memory = store()
    let finished: MasterSession | undefined
    await memory.runExclusive(async (tx) => {
      expect("persistVersion" in tx).toBe(false)
      expect("pgClient" in tx).toBe(false)
      finished = tx
    })
    await expect(finished!.getProposal("missing")).rejects.toThrow(/master session is closed/)
    await expect(
      finished!.commitVersion({
        firmId: "firmA",
        proposalId: null,
        action: "rollback",
        diff: { key: "*", partition: "mutable", before: { entries: {} }, after: { entries: {} } },
        snapshot: { entries: {} },
        authorId: "clerk_x",
        authorKind: "partner",
        restoredFromVersionId: null,
        classification: "internal",
        proposal: null,
        expectedBaseVersionId: null,
      }),
    ).rejects.toThrow(/master session is closed/)
  })

  it("authorId must equal the stored decidedBy, and a cosmetic author must be the system", async () => {
    const memory = store()
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.exact",
        payload: { wording: "exact" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(pending.id, PARTNER, memory)
    const stored = await memory.getProposal(pending.id)
    await memory.runExclusive(async (tx) => {
      const current = await tx.currentSnapshot("firmA")
      const snapshot = nextSnapshot(current, stored!)
      const applied = { ...stored!, status: "applied" as const }
      expect(await tx.casProposal(applied, "approved")).toBe(true)
      await expect(
        tx.commitVersion({
          firmId: "firmA",
          proposalId: stored!.id,
          action: "apply",
          diff: { key: stored!.entryKey, partition: "mutable", before: current, after: snapshot },
          snapshot,
          authorId: "Partner_B",
          authorKind: "partner",
          restoredFromVersionId: null,
          classification: "confidential",
          proposal: applied,
          expectedBaseVersionId: await tx.lockFirm("firmA"),
        }),
      ).rejects.toThrow(/partner approval/)
    })
    const cosmetic = await memory.insertProposal({
      id: "00000000-0000-4000-8000-000000000272",
      firmId: "firmB",
      sourceModule: "15",
      classification: "internal",
      changeClass: "cosmetic",
      requestedClass: "cosmetic",
      partition: "mutable",
      entryKey: "clause.cosmetic",
      payload: { wording: "tidy" },
      proposedBy: "learner-1",
      status: "pending",
      decidedBy: null,
      decidedKind: null,
      decidedRole: null,
      declassify: false,
      payloadHash: "pending",
    })
    const empty = await memory.currentSnapshot("firmB")
    const cosmeticSnapshot = nextSnapshot(empty, cosmetic)
    await expect(
      memory.commitVersion({
        firmId: "firmB",
        proposalId: cosmetic.id,
        action: "apply",
        diff: { key: cosmetic.entryKey, partition: "mutable", before: empty, after: cosmeticSnapshot },
        snapshot: cosmeticSnapshot,
        authorId: "clerk_x",
        authorKind: "system",
        restoredFromVersionId: null,
        classification: "internal",
        proposal: cosmetic,
        expectedBaseVersionId: null,
      }),
    ).rejects.toThrow(/cosmetic proposal is not pending/)
    expect(await memory.listVersions("firmA")).toEqual([])
    expect(await memory.listVersions("firmB")).toEqual([])
  })
})
