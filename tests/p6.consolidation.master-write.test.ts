/**
 * L16.3 — one master write path (v19 L5561–L5594, L17.5 L7051–L7086, G-3 L8488).
 * These tests are red on 8271124d: the canonical module does not exist, and the
 * table statements still live in platform/p6/masterStore.ts.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import pg from "pg"
import { learningBaselinePayload } from "@/platform/p6/learning/baseline"
import { LearningStaleError } from "@/platform/p6/learning/stale"
import {
  createPgMasterStore,
  InMemoryMasterStore,
  writeMaster,
  type CommitVersionInput,
  type MasterSession,
  type MasterSnapshot,
  type MasterStore,
  type VersionRow,
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
import * as writerModule from "@/platform/p6/masterWrite"

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
    expect(writerSource).not.toMatch(/export function publishStagedMasterWrites/)
    expect(writerSource).not.toMatch(/export async function runOneApply/)
    expect(storeSource).toMatch(/#state\b/)
    expect(storeSource).toMatch(/#rawSession\b/)
    expect(storeSource).not.toMatch(/\bprivate (?:readonly )?state\b/)
    expect(storeSource).not.toMatch(/\bprivate rawSession\b/)
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
    ).toEqual(["platform/p6/masterWrite.ts"])
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
    expect(
      masterWriteViolations([
        { path: "platform/p6/destructure.ts", source: "const { writeMaster: w } = await import('@/platform/p6/masterStore')\n" },
      ]),
    ).toEqual(["platform/p6/destructure.ts"])
    expect(
      masterWriteViolations([{ path: "platform/p6/call.ts", source: "writeMaster.call(null, input, session, gate)\n" }]),
    ).toEqual(["platform/p6/call.ts"])
    expect(
      masterWriteViolations([{ path: "platform/p6/apply.ts", source: "writeMaster.apply(null, [input, session, gate])\n" }]),
    ).toEqual(["platform/p6/apply.ts"])
    expect(
      masterWriteViolations([
        { path: "platform/p6/reflect.ts", source: "Reflect.apply(writeMaster, null, [input, session, gate])\n" },
      ]),
    ).toEqual(["platform/p6/reflect.ts"])
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

  it("BYPASS-271-R3-001: in-memory internals stay unreachable, and a pending substantive proposal is not applied", async () => {
    const memory = store()
    const pending = await memory.insertProposal({
      id: "00000000-0000-4000-8000-000000000301",
      firmId: "firmA",
      sourceModule: "15",
      classification: "confidential",
      changeClass: "substantive",
      requestedClass: null,
      partition: "mutable",
      entryKey: "clause.private",
      payload: { wording: "still pending" },
      proposedBy: "learner-1",
      status: "pending",
      decidedBy: null,
      decidedKind: null,
      decidedRole: null,
      declassify: false,
      payloadHash: "pending",
    })
    const opened = memory as unknown as Record<string, unknown>
    expect(opened.rawSession).toBeUndefined()
    expect(opened.state).toBeUndefined()
    expect(opened.failCommit).toBeUndefined()
    expect(opened.gate).toBeUndefined()
    expect(opened.dead).toBeUndefined()
    expect(opened.assertLive).toBeUndefined()
    expect(opened.endSession).toBeUndefined()
    expect(opened.publicSession).toBeUndefined()
    expect(opened.assertRole).toBeUndefined()
    expect(opened.saveVersion).toBeUndefined()
    expect(Reflect.get(memory, "state")).toBeUndefined()
    expect(Reflect.get(memory, "rawSession")).toBeUndefined()
    expect(Reflect.get(memory, "saveVersion")).toBeUndefined()
    const names = new Set<string>()
    for (let cursor: object | null = memory; cursor !== null; cursor = Object.getPrototypeOf(cursor)) {
      for (const name of Object.getOwnPropertyNames(cursor)) names.add(name)
      for (const name of Object.getOwnPropertySymbols(cursor)) names.add(String(name))
    }
    for (const hidden of [
      "state",
      "rawSession",
      "failCommit",
      "gate",
      "dead",
      "saveVersion",
      "assertRole",
      "publicSession",
      "endSession",
      "assertLive",
    ]) {
      expect(names.has(hidden), hidden).toBe(false)
    }
    opened.state = { proposals: new Map() }
    expect(Reflect.get(memory, "state")).toEqual({ proposals: expect.any(Map) })
    expect((await memory.getProposal(pending.id))?.payload).toEqual({ wording: "still pending" })
    expect(() => (memory as unknown as { rawSession: (staged: unknown[]) => unknown }).rawSession([])).toThrow(TypeError)
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
    expect((await memory.getProposal(pending.id))?.status).toBe("pending")
    expect(await memory.listVersions("firmA")).toEqual([])
  })

  it("FA-271-R3-002: the real masterWrite.ts file is scanned and is not a second writer", () => {
    expect(scanP6MasterWriters()).toEqual([])
    expect(masterWriteViolations([{ path: "platform/p6/masterWrite.ts", source: readFileSync("platform/p6/masterWrite.ts", "utf8") }])).toEqual(
      [],
    )
  })

  it("TEST-271-R3-003: export-seal, a no-op retire, and a lying session read do not commit", async () => {
    expect("seal" in storeModule).toBe(false)
    expect("sealMasterSession" in storeModule).toBe(false)
    expect("seal" in writerModule).toBe(false)
    expect("sealMasterSession" in writerModule).toBe(false)
    const exportedSeal = (storeModule as Record<string, unknown>).seal ?? (writerModule as Record<string, unknown>).seal
    expect(typeof exportedSeal).not.toBe("function")

    const memory = store()
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.mutant",
        payload: { wording: "held" },
        proposedBy: "learner-1",
      },
      memory,
    )
    let finished: MasterSession | undefined
    await memory.runExclusive(async (tx) => {
      finished = tx
      const stored = await tx.getProposal(pending.id)
      const current = await tx.currentSnapshot("firmA")
      const snapshot = nextSnapshot(current, stored!)
      tx.getProposal = async () => ({
        ...stored!,
        status: "approved",
        decidedBy: "partner_b",
        decidedKind: "partner",
        decidedRole: "partner",
      })
      await expect(
        tx.commitVersion({
          firmId: "firmA",
          proposalId: pending.id,
          action: "apply",
          diff: { key: pending.entryKey, partition: "mutable", before: current, after: snapshot },
          snapshot,
          authorId: "partner_b",
          authorKind: "partner",
          restoredFromVersionId: null,
          classification: "confidential",
          proposal: null,
          expectedBaseVersionId: await tx.lockFirm("firmA"),
        }),
      ).rejects.toThrow(/partner approval/)
    })
    expect((await memory.getProposal(pending.id))?.status).toBe("pending")
    expect(await memory.listVersions("firmA")).toEqual([])

    await approveProposal(pending.id, PARTNER, memory)
    const stored = await memory.getProposal(pending.id)
    const current = await memory.currentSnapshot("firmA")
    const snapshot = nextSnapshot(current, stored!)
    await expect(
      writeMaster(
        {
          firmId: "firmA",
          proposalId: pending.id,
          action: "apply",
          diff: { key: pending.entryKey, partition: "mutable", before: current, after: snapshot },
          snapshot,
          authorId: "partner_b",
          authorKind: "partner",
          restoredFromVersionId: null,
          classification: "confidential",
          proposal: null,
          expectedBaseVersionId: null,
        },
        finished!,
        { declassify: false },
      ),
    ).rejects.toThrow(/master session is closed/)
    expect((await memory.getProposal(pending.id))?.status).toBe("approved")
    expect(await memory.listVersions("firmA")).toEqual([])
  })

  it("AUDIT-271-R3-004: an exported publisher cannot forge a committed audit entry or mark a proposal applied", async () => {
    const memory = store()
    const pending = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.audit-forge",
        payload: { wording: "real apply" },
        proposedBy: "learner-1",
      },
      memory,
    )
    await approveProposal(pending.id, PARTNER, memory)
    expect("publishStagedMasterWrites" in writerModule).toBe(false)
    expect("publishStagedMasterWrites" in storeModule).toBe(false)
    expect("runOneApply" in writerModule).toBe(false)
    expect("runOneApply" in storeModule).toBe(false)
    const forged =
      (writerModule as Record<string, unknown>).publishStagedMasterWrites ??
      (storeModule as Record<string, unknown>).publishStagedMasterWrites
    const before = masterWriteAuditLog().length
    if (typeof forged === "function") {
      forged([
        {
          proposalId: pending.id,
          entry: {
            action: "apply",
            firmId: "firmA",
            proposalId: pending.id,
            actorId: "partner_b",
            versionId: "forged-version",
            outcome: "committed",
          },
        },
      ])
    }
    expect(typeof forged).not.toBe("function")
    expect(masterWriteAuditLog().length).toBe(before)
    expect(masterWriteAuditLog().some((row) => row.versionId === "forged-version")).toBe(false)
    const applied = await applyChange(pending.id, memory)
    expect(applied.masterWritten).toBe(true)
    expect((await memory.getProposal(pending.id))?.status).toBe("applied")
    expect(masterWriteAuditLog().some((row) => row.versionId === applied.versionId && row.outcome === "committed")).toBe(true)
  })

  it("BYPASS-281-001: assigning getProposal and currentSnapshot cannot apply a pending substantive change", async () => {
    const memory = new InMemoryMasterStore({ role: "p6_service" })
    const { pending, input } = await pendingSubstantive(memory, "00000000-0000-4000-8000-000000000311", "clause.assign")
    const realSnapshot = await memory.currentSnapshot("firmA")
    memory.getProposal = async () => approvedLie(pending)
    memory.currentSnapshot = async () => realSnapshot
    await expectRefused(memory, input, pending.id)
  })

  it("BYPASS-281-001: a subclass cannot apply a pending substantive change through overridden readers", async () => {
    const memory = new LyingStore()
    const { pending, input } = await pendingSubstantive(memory, "00000000-0000-4000-8000-000000000312", "clause.subclass")
    await expectRefused(memory, input, pending.id)
  })

  it("BYPASS-281-001: a prototype patch cannot apply a pending substantive change", async () => {
    const memory = new InMemoryMasterStore({ role: "p6_service" })
    const { pending, input } = await pendingSubstantive(memory, "00000000-0000-4000-8000-000000000313", "clause.proto")
    const realSnapshot = await InMemoryMasterStore.prototype.currentSnapshot.call(memory, "firmA")
    const originalProposal = InMemoryMasterStore.prototype.getProposal
    const originalSnapshot = InMemoryMasterStore.prototype.currentSnapshot
    InMemoryMasterStore.prototype.getProposal = async () => approvedLie(pending)
    InMemoryMasterStore.prototype.currentSnapshot = async () => realSnapshot
    try {
      await expect(memory.commitVersion(input)).rejects.toThrow(/partner approval/)
      expect((await originalProposal.call(memory, pending.id))?.status).toBe("pending")
      expect(await memory.listVersions("firmA")).toEqual([])
    } finally {
      InMemoryMasterStore.prototype.getProposal = originalProposal
      InMemoryMasterStore.prototype.currentSnapshot = originalSnapshot
    }
  })

  it("BYPASS-287-001: two fresh firms do not share a mutable empty snapshot", async () => {
    const pgStore = createPgMasterStore(emptyFirmPool())
    const left = await pgStore.currentSnapshot("firm-fresh-a")
    const right = await pgStore.currentSnapshot("firm-fresh-b")
    expect(left).not.toBe(right)
    expect(Object.isFrozen(left)).toBe(true)
    expect(Object.isFrozen(left.entries)).toBe(true)
    expect(() => {
      left.entries["unproposed"] = {
        partition: "mutable",
        key: "unproposed",
        body: { leaked: true },
        classification: "confidential",
      }
    }).toThrow(TypeError)
    expect(Object.keys(right.entries)).toEqual([])
    expect(Object.keys((await pgStore.currentSnapshot("firm-fresh-a")).entries)).toEqual([])
    expect(Object.keys((await pgStore.currentSnapshot("firm-fresh-b")).entries)).toEqual([])
  })

  it("a stale approved learning change sent to commitVersion cannot overwrite a later partner change", async () => {
    const memory = new InMemoryMasterStore({ role: "p6_service" })
    const seeded = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "seed",
        classification: "confidential",
        payload: { clause: "X" },
        proposedBy: "seed-author",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.notice",
      },
      memory,
    )
    await approveProposal(seeded.id, { actorId: "seed-partner", kind: "partner", role: "partner" }, memory)
    await applyChange(seeded.id, memory)
    const learning = await memory.insertProposal({
      id: "00000000-0000-4000-8000-000000000287",
      firmId: "firmA",
      sourceModule: "L4.6",
      classification: "confidential",
      changeClass: "substantive",
      requestedClass: null,
      partition: "mutable",
      entryKey: "clause.notice",
      payload: learningBaselinePayload({ clause: "X" }, { clause: "Y" }),
      proposedBy: "learner-1",
      status: "pending",
      decidedBy: null,
      decidedKind: null,
      decidedRole: null,
      declassify: false,
      payloadHash: "pending",
    })
    await approveProposal(learning.id, PARTNER, memory)
    const moved = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "partner-desk",
        classification: "confidential",
        payload: { clause: "Z" },
        proposedBy: "other-author",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.notice",
      },
      memory,
    )
    await approveProposal(moved.id, { actorId: "partner_z", kind: "partner", role: "partner" }, memory)
    await applyChange(moved.id, memory)
    const stored = await memory.getProposal(learning.id)
    const current = await memory.currentSnapshot("firmA")
    const snapshot = nextSnapshot(current, stored!)
    await expect(
      memory.commitVersion({
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
        expectedBaseVersionId: (await memory.listVersions("firmA")).at(-1)?.id ?? null,
      }),
    ).rejects.toBeInstanceOf(LearningStaleError)
    expect((await memory.currentSnapshot("firmA")).entries["clause.notice"]?.body).toEqual({ clause: "Z" })
    expect((await memory.getProposal(learning.id))?.status).toBe("approved")
  })

  it("TEST-287-003: public currentSnapshot and getVersion cannot steer the sealed writer", async () => {
    const snapshotStore = new ReaderHole()
    const kept = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.keep",
        payload: { wording: "beta" },
        proposedBy: "learner-1",
      },
      snapshotStore,
    )
    await approveProposal(kept.id, PARTNER, snapshotStore)
    await applyChange(kept.id, snapshotStore)
    const attack = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.keep",
        payload: { wording: "attacker" },
        proposedBy: "learner-1",
      },
      snapshotStore,
    )
    await approveProposal(attack.id, PARTNER, snapshotStore)
    const storedAttack = await snapshotStore.getProposal(attack.id)
    const empty: MasterSnapshot = { entries: {} }
    const attacked = nextSnapshot(empty, storedAttack!)
    snapshotStore.lieSnapshot = empty
    await expect(
      snapshotStore.commitVersion({
        firmId: "firmA",
        proposalId: storedAttack!.id,
        action: "apply",
        diff: { key: storedAttack!.entryKey, partition: "mutable", before: empty, after: attacked },
        snapshot: attacked,
        authorId: "partner_b",
        authorKind: "partner",
        restoredFromVersionId: null,
        classification: "confidential",
        proposal: null,
        expectedBaseVersionId: (await snapshotStore.listVersions("firmA")).at(-1)?.id ?? null,
      }),
    ).rejects.toThrow(/bound to the proposal/)
    expect((await InMemoryMasterStore.prototype.currentSnapshot.call(snapshotStore, "firmA")).entries["clause.keep"]?.body).toEqual({
      wording: "beta",
    })

    const versionStore = new ReaderHole()
    const original = await proposeChange(
      {
        firmId: "firmA",
        sourceModule: "15",
        classification: "confidential",
        changeClass: "substantive",
        partition: "mutable",
        entryKey: "clause.keep",
        payload: { wording: "beta" },
        proposedBy: "learner-1",
      },
      versionStore,
    )
    await approveProposal(original.id, PARTNER, versionStore)
    const applied = await applyChange(original.id, versionStore)
    const real = await versionStore.getVersion(applied.versionId)
    const forged: MasterSnapshot = {
      entries: {
        "clause.keep": {
          partition: "mutable",
          key: "clause.keep",
          body: { wording: "forged rollback" },
          classification: "confidential",
        },
      },
    }
    versionStore.lieVersion = { ...real!, snapshot: forged }
    const before = await InMemoryMasterStore.prototype.currentSnapshot.call(versionStore, "firmA")
    await expect(
      versionStore.commitVersion({
        firmId: "firmA",
        proposalId: null,
        action: "rollback",
        diff: { key: "*", partition: "mutable", before, after: forged },
        snapshot: forged,
        authorId: "partner_b",
        authorKind: "partner",
        restoredFromVersionId: applied.versionId,
        classification: "confidential",
        proposal: null,
        expectedBaseVersionId: applied.versionId,
      }),
    ).rejects.toThrow(/bound to the proposal/)
    expect((await InMemoryMasterStore.prototype.currentSnapshot.call(versionStore, "firmA")).entries["clause.keep"]?.body).toEqual({
      wording: "beta",
    })
  })

  it("TEST-281-003: the audit log does not hand back the live array", () => {
    const live = masterWriteAuditLog()
    const forged = {
      action: "apply" as const,
      firmId: "firmA",
      proposalId: "g20",
      actorId: "partner_b",
      versionId: "g20-live-array",
      outcome: "committed" as const,
    }
    ;(live as unknown as (typeof forged)[]).push(forged)
    expect(masterWriteAuditLog()).not.toBe(live)
    expect(masterWriteAuditLog().some((row) => row.versionId === "g20-live-array")).toBe(false)
  })
})

function approvedLie(row: Awaited<ReturnType<InMemoryMasterStore["getProposal"]>> & object) {
  return {
    ...row,
    status: "approved" as const,
    decidedBy: "partner_b",
    decidedKind: "partner" as const,
    decidedRole: "partner" as const,
  }
}

async function pendingSubstantive(memory: InMemoryMasterStore, id: string, entryKey: string) {
  const pending = await memory.insertProposal({
    id,
    firmId: "firmA",
    sourceModule: "15",
    classification: "confidential",
    changeClass: "substantive",
    requestedClass: null,
    partition: "mutable",
    entryKey,
    payload: { wording: "never approved" },
    proposedBy: "learner-1",
    status: "pending",
    decidedBy: null,
    decidedKind: null,
    decidedRole: null,
    declassify: false,
    payloadHash: "pending",
  })
  const current = await InMemoryMasterStore.prototype.currentSnapshot.call(memory, "firmA")
  const snapshot = nextSnapshot(current, pending)
  const input: CommitVersionInput = {
    firmId: "firmA",
    proposalId: pending.id,
    action: "apply",
    diff: { key: pending.entryKey, partition: "mutable", before: current, after: snapshot },
    snapshot,
    authorId: "partner_b",
    authorKind: "partner",
    restoredFromVersionId: null,
    classification: "confidential",
    proposal: null,
    expectedBaseVersionId: null,
  }
  return { pending, input }
}

async function expectRefused(memory: InMemoryMasterStore, input: CommitVersionInput, id: string) {
  await expect(memory.commitVersion(input)).rejects.toThrow(/partner approval/)
  expect((await InMemoryMasterStore.prototype.getProposal.call(memory, id))?.status).toBe("pending")
  expect(await memory.listVersions("firmA")).toEqual([])
}

function emptyFirmPool(): pg.Pool {
  const client = {
    query: async () => ({ rows: [], rowCount: 0 }),
    release() {},
  }
  return { connect: async () => client } as unknown as pg.Pool
}

class ReaderHole extends InMemoryMasterStore {
  lieSnapshot: MasterSnapshot | null = null
  lieVersion: VersionRow | null = null

  constructor() {
    super({ role: "p6_service" })
  }

  override async currentSnapshot(firmId: string) {
    if (this.lieSnapshot) return this.lieSnapshot
    return InMemoryMasterStore.prototype.currentSnapshot.call(this, firmId)
  }

  override async getVersion(id: string) {
    if (this.lieVersion) return this.lieVersion
    return InMemoryMasterStore.prototype.getVersion.call(this, id)
  }
}

class LyingStore extends InMemoryMasterStore {
  constructor() {
    super({ role: "p6_service" })
  }

  override async getProposal(id: string) {
    const row = await InMemoryMasterStore.prototype.getProposal.call(this, id)
    return row ? approvedLie(row) : null
  }

  override async currentSnapshot(firmId: string) {
    return InMemoryMasterStore.prototype.currentSnapshot.call(this, firmId)
  }
}
