import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { canonicalJson } from "../src/http/idempotency"
import * as custody from "../src/d1/evidence/custody"
import * as exported from "../src/d1/evidence/export"
import * as flag from "../src/d1/evidence/flag"
import * as register from "../src/d1/evidence/register"
import * as types from "../src/d1/evidence/types"
import {
  GENESIS_PREV_HASH,
  custodyBody,
  custodyEventHash,
  genesisEventHash,
  inspectCustodyChain,
  type CustodyEvent,
  type EvidenceItem,
  type GenesisEvent,
} from "../src/d1/evidence/types"

/**
 * Export surface: the module API has the register and chain operations and no
 * update or delete. The hash and the renderer are pure, so these tests do not
 * need the emulator.
 */

const FORBIDDEN = /(update|delete|remove|destroy|erase)/i

const EXPECTED = [
  "D1_EVIDENCE_FLAG",
  "isD1EvidenceEnabled",
  "requireD1Evidence",
  "EvidenceError",
  "EVIDENCE_ITEMS",
  "CUSTODY_EVENTS",
  "GENESIS_PREV_HASH",
  "CUSTODY_KINDS",
  "custodyBody",
  "custodyEventHash",
  "genesisEventHash",
  "parseCustodyEvent",
  "parseGenesisEvent",
  "inspectCustodyChain",
  "atLeastClassification",
  "logEvidence",
  "getEvidenceRegister",
  "getEvidenceItem",
  "linkEvidenceToDocument",
  "addCustodyEvent",
  "getCustodyTrail",
  "verifyCustodyChain",
  "exportEvidenceLog",
  "renderEvidenceLog",
]

function event(over: Partial<CustodyEvent> = {}): CustodyEvent {
  const body = {
    evidenceId: "ev1",
    firmId: "firmA",
    matterId: "matterA",
    seq: 1,
    kind: "receipt" as const,
    actorId: "user-1",
    at: "2026-01-15T00:00:00.000Z",
    note: "sealed bag",
    custodian: "clerk A",
    documentId: null,
    classification: "internal" as const,
    prevHash: GENESIS_PREV_HASH,
  }
  const row: CustodyEvent = { ...body, id: "ev1_1", hash: custodyEventHash(body), ...over }
  if (over.hash === undefined && (over.note !== undefined || over.prevHash !== undefined || over.seq !== undefined)) {
    const { id: _id, hash: _hash, ...rest } = row
    row.hash = custodyEventHash(rest)
  }
  return row
}

function item(over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "ev1",
    firmId: "firmA",
    matterId: "matterA",
    item: "seized phone",
    source: "complainant",
    receiptDate: "2026-01-15",
    custodian: "clerk A",
    classification: "internal",
    documentId: null,
    createdBy: "user-1",
    createdAt: "2026-01-15T00:00:00.000Z",
    eventCount: 1,
    headerHash: "ab".repeat(32),
    lastHash: "cd".repeat(32),
    ...over,
  }
}

function genesis(row: EvidenceItem, over: Partial<GenesisEvent> = {}): GenesisEvent {
  const body: Omit<GenesisEvent, "id" | "hash"> = {
    evidenceId: row.id,
    firmId: row.firmId,
    matterId: row.matterId,
    seq: 0,
    kind: "genesis",
    actorId: row.createdBy,
    at: row.createdAt,
    note: "",
    custodian: row.custodian,
    documentId: null,
    classification: row.classification,
    item: row.item,
    source: row.source,
    receiptDate: row.receiptDate,
    prevHash: GENESIS_PREV_HASH,
    ...over,
  }
  const { id: _id, hash: _hash, ...rest } = { ...body, id: `${row.id}_0`, hash: "" }
  return { ...rest, id: `${row.id}_0`, hash: over.hash ?? genesisEventHash(rest) }
}

describe("D1 evidence export surface and hash", () => {
  it("the module API has no update or delete", () => {
    const names = [flag, register, custody, exported, types].flatMap((mod) => Object.keys(mod))
    expect(names.filter((name) => FORBIDDEN.test(name))).toEqual([])
    expect([...new Set(names)].sort()).toEqual([...EXPECTED].sort())
  })

  it("hash is sha256 of canonical JSON without the hash field, concatenated with prevHash", () => {
    const row = event()
    const { id: _id, hash: _hash, ...body } = row
    const expected = createHash("sha256").update(canonicalJson(custodyBody(body)) + body.prevHash, "utf8").digest("hex")
    expect(row.hash).toBe(expected)
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/)
    const moved = custodyEventHash({ ...body, prevHash: "abc" })
    expect(moved).not.toBe(row.hash)
    expect(moved).toBe(createHash("sha256").update(canonicalJson(custodyBody({ ...body, prevHash: "abc" })) + "abc", "utf8").digest("hex"))
  })

  it("a changed note breaks inspect at that seq and a gap is the missing seq", () => {
    const row = item({ eventCount: 2 })
    const origin = genesis(row)
    const first = event({ prevHash: origin.hash })
    const secondBody = {
      evidenceId: first.evidenceId,
      firmId: first.firmId,
      matterId: first.matterId,
      seq: 2,
      kind: "condition" as const,
      actorId: first.actorId,
      at: "2026-01-15T01:00:00.000Z",
      note: "seal intact",
      custodian: first.custodian,
      documentId: null,
      classification: "internal" as const,
      prevHash: first.hash,
    }
    const second = event({ ...secondBody, id: "ev1_2", hash: custodyEventHash(secondBody) })
    const header = { ...row, headerHash: origin.hash, lastHash: second.hash, eventCount: 2 }
    expect(inspectCustodyChain(header, origin, [first, second])).toEqual({ ok: true, eventCount: 2 })
    const tampered = { ...second, note: "seal broken" }
    expect(inspectCustodyChain(header, origin, [first, tampered])).toEqual({ ok: false, brokenSeq: 2, reason: "hash" })
    expect(inspectCustodyChain({ ...header, eventCount: 1, lastHash: first.hash }, origin, [first])).toEqual({
      ok: true,
      eventCount: 1,
    })
    const third = event({ ...secondBody, seq: 3, id: "ev1_3", prevHash: second.hash })
    const { id: _i, hash: _h, ...thirdBody } = third
    third.hash = custodyEventHash(thirdBody)
    expect(inspectCustodyChain({ ...header, eventCount: 3, lastHash: third.hash }, origin, [first, third])).toMatchObject({
      brokenSeq: 2,
      reason: "gap",
    })
  })

  it("a missing tail or a count past the header fails inspect at that seq", () => {
    const row = item({ eventCount: 2 })
    const origin = genesis(row)
    const first = event({ prevHash: origin.hash })
    const second = event({
      seq: 2,
      id: "ev1_2",
      note: "second",
      prevHash: first.hash,
      at: "2026-01-15T01:00:00.000Z",
    })
    const header = { ...row, headerHash: origin.hash, lastHash: second.hash, eventCount: 2 }
    expect(inspectCustodyChain(header, origin, [first])).toEqual({ ok: false, brokenSeq: 2, reason: "gap" })
    expect(inspectCustodyChain({ ...header, eventCount: 1, lastHash: first.hash }, origin, [first, second])).toEqual({
      ok: false,
      brokenSeq: 2,
      reason: "count",
    })
    expect(inspectCustodyChain({ ...header, lastHash: first.hash }, origin, [first, second])).toEqual({
      ok: false,
      brokenSeq: 2,
      reason: "hash",
    })
  })

  it("editing a header field bound into genesis fails inspect", () => {
    const row = item({ eventCount: 1 })
    const origin = genesis(row)
    const first = event({ prevHash: origin.hash })
    const header = { ...row, headerHash: origin.hash, lastHash: first.hash, eventCount: 1 }
    expect(inspectCustodyChain(header, origin, [first])).toEqual({ ok: true, eventCount: 1 })
    expect(inspectCustodyChain({ ...header, item: "substituted exhibit" }, origin, [first])).toEqual({
      ok: false,
      brokenSeq: 0,
      reason: "header",
    })
    expect(inspectCustodyChain({ ...header, classification: "public" }, origin, [first])).toEqual({
      ok: false,
      brokenSeq: 0,
      reason: "header",
    })
    const rewritten = { ...origin, item: "substituted exhibit" }
    expect(inspectCustodyChain({ ...header, item: rewritten.item, headerHash: origin.hash }, rewritten, [first])).toEqual({
      ok: false,
      brokenSeq: 0,
      reason: "hash",
    })
  })

  it("the renderer is deterministic and writes every hash in seq order", () => {
    const first = event()
    const secondBody = {
      evidenceId: first.evidenceId,
      firmId: first.firmId,
      matterId: first.matterId,
      seq: 2,
      kind: "annotation" as const,
      actorId: "user-1",
      at: "2026-01-15T02:00:00.000Z",
      note: "photographed",
      custodian: "clerk A",
      documentId: null,
      classification: "internal" as const,
      prevHash: first.hash,
    }
    const second = event({ ...secondBody, id: "ev1_2", hash: custodyEventHash(secondBody) })
    const row = item({ eventCount: 2 })
    const a = exported.renderEvidenceLog(row, [second, first], null)
    const b = exported.renderEvidenceLog(row, [first, second], null)
    expect(Buffer.from(a.json, "utf8").equals(Buffer.from(b.json, "utf8"))).toBe(true)
    expect(Buffer.from(a.text, "utf8").equals(Buffer.from(b.text, "utf8"))).toBe(true)
    const parsed = JSON.parse(a.json) as { events: { seq: number; hash: string; prevHash: string }[] }
    expect(parsed.events.map((e) => e.seq)).toEqual([1, 2])
    for (const ev of [first, second]) {
      expect(a.json).toContain(ev.hash)
      expect(a.text).toContain(ev.hash)
      expect(a.json).toContain(ev.prevHash)
      expect(a.text).toContain(ev.prevHash)
    }
    expect(a.json).not.toContain("exportedAt")
    expect(a.text.endsWith("\n")).toBe(true)
  })
})
