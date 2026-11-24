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
  writeMaster,
  type CommitVersionInput,
  type MasterSession,
  type MasterStore,
} from "@/platform/p6/masterStore"
import { applyChange, approveProposal, proposeChange, rollbackMaster, type ApprovalActor } from "@/platform/p6/proposeChange"
import {
  masterWriteAuditLog,
  masterWriteViolations,
  nextSnapshot,
  scanP6MasterWriters,
} from "@/platform/p6/masterWrite"
import * as p6Index from "@/platform/p6"
import * as storeModule from "@/platform/p6/masterStore"

const PARTNER: ApprovalActor = { actorId: "partner_b", kind: "partner", role: "partner" }

function store(): MasterStore {
  return new InMemoryMasterStore({ role: "p6_service" })
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
    expect(storeSource).toMatch(/INSERT INTO master_versions/)
    expect(storeSource).not.toMatch(/export (?:async )?function sealMasterSession/)
    expect(storeSource).not.toMatch(/\bsealMasterSession\s*\(/)
    expect(storeSource).not.toMatch(/\.commitVersion\s*\(/)
    expect(storeSource).not.toMatch(/executeMasterTableWrite\s*\(/)
    expect(storeSource).toMatch(/guardedWrite\(/)
    expect(storeSource).toMatch(/async #saveVersion/)
    const writerSource = readFileSync("platform/p6/masterWrite.ts", "utf8")
    expect(writerSource).not.toMatch(/INSERT INTO master_versions/)
    expect(writerSource).not.toMatch(/export (?:async )?function sealMasterSession/)
    expect(writerSource).not.toMatch(/export async function writeMaster/)
  })

  it("an unapproved write refuses and does not commit", async () => {
    const memory = store()
    const pending = await memory.insertProposal({
      id: "00000000-0000-4000-8000-000000000281",
      firmId: "firmA",
      sourceModule: "15",
      classification: "confidential",
      changeClass: "substantive",
      requestedClass: null,
      partition: "mutable",
      entryKey: "clause.unapproved",
      payload: { wording: "not yet" },
      proposedBy: "learner-1",
      status: "pending",
      decidedBy: null,
      decidedKind: null,
      decidedRole: null,
      declassify: false,
      payloadHash: "pending",
    })
    const current = await memory.currentSnapshot("firmA")
    const snapshot = nextSnapshot(current, pending)
    await expect(
      memory.commitVersion({
        firmId: "firmA",
        proposalId: pending.id,
        action: "apply",
        diff: { key: pending.entryKey, partition: "mutable", before: current, after: snapshot },
        snapshot,
        authorId: "p6",
        authorKind: "system",
        restoredFromVersionId: null,
        classification: "confidential",
        proposal: pending,
        expectedBaseVersionId: null,
      }),
    ).rejects.toThrow(/partner approval/)
    expect(await memory.listVersions("firmA")).toEqual([])
    expect(masterWriteAuditLog().some((entry) => entry.proposalId === pending.id)).toBe(false)
  })

  it("an actor mismatch refuses, including a case-folded approver", async () => {
    const memory = store()
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.fold",
        payload: { wording: "folded" },
        proposedBy: "Partner_A",
      },
      memory,
    )
    await expect(
      approveProposal(pending.id, { actorId: "partner_a", kind: "partner", role: "partner" }, memory),
    ).rejects.toThrow(/approver must differ from proposer/)
    expect((await memory.getProposal(pending.id))?.status).toBe("pending")
    expect(await memory.listVersions("firmA")).toEqual([])
  })

  it("a concurrent double-apply applies once", async () => {
    const memory = store()
    const approved = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.race",
        payload: { wording: "race" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(approved.id, PARTNER, memory)
    const stored = await memory.getProposal(approved.id)
    const current = await memory.currentSnapshot("firmA")
    const snapshot = nextSnapshot(current, stored!)
    const input: CommitVersionInput = {
      firmId: "firmA",
      proposalId: stored!.id,
      action: "apply",
      diff: { key: stored!.entryKey, partition: "mutable", before: current, after: snapshot },
      snapshot,
      authorId: "partner_b",
      authorKind: "partner",
      restoredFromVersionId: null,
      classification: "confidential",
      proposal: null,
      expectedBaseVersionId: null,
    }
    const raced = await Promise.allSettled([memory.commitVersion(input), memory.commitVersion(input)])
    expect(raced.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(raced.filter((item) => item.status === "rejected")).toHaveLength(1)
    expect(await memory.listVersions("firmA")).toHaveLength(1)

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
    expect(
      masterWriteViolations([{ path: "platform/p6/seal.ts", source: "export function sneak(session, raw) { sealMasterSession(session, raw) }\n" }]),
    ).toEqual(["platform/p6/seal.ts"])
    expect(
      masterWriteViolations([
        { path: "platform/p6/alias.ts", source: "import { writeMaster as w } from '@/platform/p6/masterStore'\n" },
      ]),
    ).toEqual(["platform/p6/alias.ts"])
    expect(
      masterWriteViolations([{ path: "platform/p6/bracket.ts", source: "m['writeMaster'](input, session, gate)\n" }]),
    ).toEqual(["platform/p6/bracket.ts"])
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
    plant("sneak.cts", "master_audit")
    writeFileSync(join(nested, "seal.cts"), "export function sneak(session, raw) { sealMasterSession(session, raw) }\n")
    try {
      expect(scanP6MasterWriters(root).sort()).toEqual([
        "platform/p6/nested/seal.cts",
        "platform/p6/nested/sneak.cjs",
        "platform/p6/nested/sneak.cts",
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
    const seeded = await proposeChange(
      {
        firmId: "firmB",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.cosmetic",
        payload: { wording: "tidy" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(seeded.id, PARTNER, memory)
    await applyChange(seeded.id, memory)
    const cosmetic = await memory.insertProposal({
      id: "00000000-0000-4000-8000-000000000272",
      firmId: "firmB",
      sourceModule: "15",
      classification: "confidential",
      changeClass: "cosmetic",
      requestedClass: "cosmetic",
      partition: "mutable",
      entryKey: "clause.cosmetic",
      payload: { wording: "tidy " },
      proposedBy: "learner-1",
      status: "pending",
      decidedBy: null,
      decidedKind: null,
      decidedRole: null,
      declassify: false,
      payloadHash: "pending",
    })
    const head = await memory.currentSnapshot("firmB")
    const base = (await memory.listVersions("firmB")).at(-1)?.id ?? null
    const cosmeticSnapshot = nextSnapshot(head, cosmetic)
    await expect(
      memory.commitVersion({
        firmId: "firmB",
        proposalId: cosmetic.id,
        action: "apply",
        diff: { key: cosmetic.entryKey, partition: "mutable", before: head, after: cosmeticSnapshot },
        snapshot: cosmeticSnapshot,
        authorId: "clerk_x",
        authorKind: "system",
        restoredFromVersionId: null,
        classification: "confidential",
        proposal: cosmetic,
        expectedBaseVersionId: base,
      }),
    ).rejects.toThrow(/cosmetic proposal is not pending/)
    expect(await memory.listVersions("firmA")).toEqual([])
    expect((await memory.getProposal(cosmetic.id))?.status).toBe("pending")
  })

  it("N8 an unsealed session is refused and saveVersion is not a public write", async () => {
    const memory = store()
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.n8",
        payload: { wording: "sealed only" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(pending.id, PARTNER, memory)
    const stored = await memory.getProposal(pending.id)
    const current = await memory.currentSnapshot("firmA")
    const snapshot = nextSnapshot(current, stored!)
    const input: CommitVersionInput = {
      firmId: "firmA",
      proposalId: stored!.id,
      action: "apply",
      diff: { key: stored!.entryKey, partition: "mutable", before: current, after: snapshot },
      snapshot,
      authorId: "partner_b",
      authorKind: "partner",
      restoredFromVersionId: null,
      classification: "confidential",
      proposal: stored!,
      expectedBaseVersionId: null,
    }
    await expect(writeMaster(input, { getProposal: async () => stored }, { declassify: false })).rejects.toThrow(/master session is closed/)
    const sneaky = memory as unknown as { saveVersion?: (value: CommitVersionInput) => Promise<unknown> }
    expect(sneaky.saveVersion).toBeUndefined()
    if (sneaky.saveVersion) await sneaky.saveVersion(input)
    expect(await memory.listVersions("firmA")).toEqual([])
    const writer = await import("@/platform/p6/masterWrite")
    expect("sealMasterSession" in writer).toBe(false)
    expect("writeMaster" in writer).toBe(false)
  })

  it("a stale cosmetic proposal cannot revert a later partner change, and an approved commit is applied", async () => {
    const memory = store()
    const first = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.stale",
        payload: { wording: "alpha" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(first.id, PARTNER, memory)
    await applyChange(first.id, memory)
    const cosmetic = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "cosmetic",
        partition: "mutable",
        entryKey: "clause.stale",
        payload: { wording: "alpha " },
        proposedBy: "learner-1",
      },
      memory,
    )
    expect(cosmetic.changeClass).toBe("cosmetic")
    const partner = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.stale",
        payload: { wording: "beta" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(partner.id, PARTNER, memory)
    await applyChange(partner.id, memory)
    await expect(applyChange(cosmetic.id, memory)).rejects.toThrow(/partner approval/)
    const current = await memory.currentSnapshot("firmA")
    const stored = await memory.getProposal(cosmetic.id)
    const snapshot = nextSnapshot(current, stored!)
    const beforeCount = (await memory.listVersions("firmA")).length
    await expect(
      memory.commitVersion({
        firmId: "firmA",
        proposalId: cosmetic.id,
        action: "apply",
        diff: { key: cosmetic.entryKey, partition: "mutable", before: current, after: snapshot },
        snapshot,
        authorId: "p6",
        authorKind: "system",
        restoredFromVersionId: null,
        classification: "confidential",
        proposal: stored,
        expectedBaseVersionId: (await memory.listVersions("firmA")).at(-1)?.id ?? null,
      }),
    ).rejects.toThrow(/partner approval/)
    expect((await memory.currentSnapshot("firmA")).entries["clause.stale"]?.body).toEqual({ wording: "beta" })
    expect((await memory.getProposal(cosmetic.id))?.status).toBe("pending")
    expect(await memory.listVersions("firmA")).toHaveLength(beforeCount)

    const approved = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.status",
        payload: { wording: "kept" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(approved.id, PARTNER, memory)
    const row = await memory.getProposal(approved.id)
    const head = await memory.currentSnapshot("firmA")
    const next = nextSnapshot(head, row!)
    const committed = await memory.commitVersion({
      firmId: "firmA",
      proposalId: row!.id,
      action: "apply",
      diff: { key: row!.entryKey, partition: "mutable", before: head, after: next },
      snapshot: next,
      authorId: "partner_b",
      authorKind: "partner",
      restoredFromVersionId: null,
      classification: "confidential",
      proposal: null,
      expectedBaseVersionId: (await memory.listVersions("firmA")).at(-1)?.id ?? null,
    })
    expect(committed.committed).toBe(true)
    expect((await memory.getProposal(approved.id))?.status).toBe("applied")
    await expect(applyChange(approved.id, memory)).rejects.toThrow(/already applied/)
  })

  it("N5 N6 N7 N10 a rollback or apply that drops a binding check is refused", async () => {
    const memory = store()
    const left = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.left",
        payload: { wording: "left" },
        proposedBy: "learner-1",
      },
      memory,
    )
    const right = await proposeChange(
      {
        firmId: "firmB",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.right",
        payload: { wording: "right" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(left.id, PARTNER, memory)
    await approveProposal(right.id, PARTNER, memory)
    const appliedLeft = await applyChange(left.id, memory)
    const appliedRight = await applyChange(right.id, memory)
    const rightVersion = await memory.getVersion(appliedRight.versionId)
    await expect(
      memory.commitVersion({
        firmId: "firmA",
        proposalId: null,
        action: "rollback",
        diff: { key: "*", partition: "mutable", before: await memory.currentSnapshot("firmA"), after: rightVersion!.snapshot },
        snapshot: rightVersion!.snapshot,
        authorId: "partner_b",
        authorKind: "partner",
        restoredFromVersionId: appliedRight.versionId,
        classification: "confidential",
        proposal: null,
        expectedBaseVersionId: appliedLeft.versionId,
      }),
    ).rejects.toThrow(/version not found/)
    expect((await memory.currentSnapshot("firmA")).entries["clause.left"]?.body).toEqual({ wording: "left" })

    const forged = {
      entries: {
        "clause.left": {
          partition: "mutable" as const,
          key: "clause.left",
          body: { wording: "forged rollback" },
          classification: "confidential" as const,
        },
      },
    }
    const leftVersion = await memory.getVersion(appliedLeft.versionId)
    await expect(
      memory.commitVersion({
        firmId: "firmA",
        proposalId: null,
        action: "rollback",
        diff: { key: "*", partition: "mutable", before: await memory.currentSnapshot("firmA"), after: forged },
        snapshot: forged,
        authorId: "partner_b",
        authorKind: "partner",
        restoredFromVersionId: appliedLeft.versionId,
        classification: "confidential",
        proposal: null,
        expectedBaseVersionId: appliedLeft.versionId,
      }),
    ).rejects.toThrow(/bound to the proposal/)
    expect((await memory.currentSnapshot("firmA")).entries["clause.left"]?.body).toEqual(leftVersion!.snapshot.entries["clause.left"]?.body)

    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.bind",
        payload: { wording: "bound" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(pending.id, PARTNER, memory)
    const stored = await memory.getProposal(pending.id)
    const current = await memory.currentSnapshot("firmA")
    const honest = nextSnapshot(current, stored!)
    const disguisedBefore = { entries: {} }
    await expect(
      memory.commitVersion({
        firmId: "firmA",
        proposalId: stored!.id,
        action: "apply",
        diff: { key: stored!.entryKey, partition: "mutable", before: disguisedBefore, after: honest },
        snapshot: honest,
        authorId: "partner_b",
        authorKind: "partner",
        restoredFromVersionId: null,
        classification: "confidential",
        proposal: null,
        expectedBaseVersionId: appliedLeft.versionId,
      }),
    ).rejects.toThrow(/bound to the proposal/)
    await expect(
      memory.commitVersion({
        firmId: "firmA",
        proposalId: stored!.id,
        action: "apply",
        diff: { key: stored!.entryKey, partition: "mutable", before: current, after: honest },
        snapshot: honest,
        authorId: "partner_b",
        authorKind: "partner",
        restoredFromVersionId: null,
        classification: "internal",
        proposal: null,
        expectedBaseVersionId: appliedLeft.versionId,
      }),
    ).rejects.toThrow(/bound to the proposal/)
    expect(await memory.getVersion(appliedLeft.versionId)).toEqual(leftVersion)
    expect((await memory.currentSnapshot("firmA")).entries["clause.bind"]).toBeUndefined()
  })

  it("a fake store cannot roll the master back to an arbitrary snapshot", async () => {
    const memory = store()
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.fake",
        payload: { wording: "real" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(pending.id, PARTNER, memory)
    const applied = await applyChange(pending.id, memory)
    const arbitrary = {
      entries: {
        forged: {
          partition: "mutable" as const,
          key: "forged",
          body: { wording: "ARBITRARY SNAPSHOT" },
          classification: "confidential" as const,
        },
      },
    }
    const fake = {
      role: "p6_service",
      async getVersion() {
        return {
          id: applied.versionId,
          firmId: "firmA",
          versionNo: 1,
          proposalId: pending.id,
          parentVersionId: null,
          action: "apply" as const,
          diff: applied.diff,
          snapshot: arbitrary,
          authorId: "partner_b",
          authorKind: "partner" as const,
          restoredFromVersionId: null,
        }
      },
      async runExclusive<T>(fn: (tx: MasterSession) => Promise<T>): Promise<T> {
        const tx = {
          async lockFirm() {
            return applied.versionId
          },
          async currentSnapshot() {
            return { entries: {} }
          },
          async currentClassification() {
            return "confidential" as const
          },
          async getVersion() {
            return fake.getVersion()
          },
          async getProposal() {
            return null
          },
          async assertCommitShape() {},
          async commitVersion() {
            throw new Error("caller commit")
          },
        }
        return fn(tx as unknown as MasterSession)
      },
    }
    await expect(
      rollbackMaster({ firmId: "firmA", toVersionId: applied.versionId, actor: PARTNER }, fake as unknown as MasterStore),
    ).rejects.toThrow(/master session is closed/)
    expect((await memory.currentSnapshot("firmA")).entries["clause.fake"]?.body).toEqual({ wording: "real" })
    expect(JSON.stringify(await memory.listVersions("firmA"))).not.toContain("ARBITRARY SNAPSHOT")
  })
})
