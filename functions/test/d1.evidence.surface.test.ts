import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
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

  it("the export prints the full genesis", () => {
    const row = item({ eventCount: 0, lastHash: "ab".repeat(32), headerHash: "ab".repeat(32) })
    const origin = genesis(row)
    const rendered = exported.renderEvidenceLog({ ...row, headerHash: origin.hash, lastHash: origin.hash }, [], origin)
    const parsed = JSON.parse(rendered.json) as { genesis: Record<string, string> }
    expect(parsed.genesis.evidenceId).toBe(origin.evidenceId)
    expect(parsed.genesis.actorId).toBe(origin.actorId)
    expect(parsed.genesis.at).toBe(origin.at)
    expect(parsed.genesis.custodian).toBe(origin.custodian)
    expect(parsed.genesis.note).toBe(origin.note)
    for (const field of [origin.evidenceId, origin.actorId, origin.at, origin.custodian, origin.note]) {
      expect(rendered.text).toContain(field)
    }
  })

  it("the first text record carries its own author line", () => {
    const row = item({ eventCount: 1, createdBy: "header-author" })
    const origin = genesis(row, { actorId: "genesis-author" })
    const laterBody = {
      evidenceId: row.id,
      firmId: row.firmId,
      matterId: row.matterId,
      seq: 1,
      kind: "receipt" as const,
      actorId: "later-author",
      at: "2026-01-15T01:00:00.000Z",
      note: "sealed bag",
      custodian: row.custodian,
      documentId: null,
      classification: "internal" as const,
      prevHash: origin.hash,
    }
    const later = event({ ...laterBody, id: "ev1_1", hash: custodyEventHash(laterBody) })
    const rendered = exported.renderEvidenceLog({ ...row, headerHash: origin.hash, lastHash: later.hash }, [later], origin)
    const first = rendered.text.split("\n---\n")[1] ?? ""
    expect(first.startsWith("seq: 0\n")).toBe(true)
    expect(first.split("\n")).toContain("actorId: genesis-author")
    expect(first).not.toContain("later-author")
    expect(first).not.toContain("header-author")
  })

  it("a headerHash, createdBy, createdAt, or documentId edit fails inspect", () => {
    const row = item({ eventCount: 1 })
    const origin = genesis(row)
    const first = event({ prevHash: origin.hash })
    const header = { ...row, headerHash: origin.hash, lastHash: first.hash, eventCount: 1 }
    expect(inspectCustodyChain(header, origin, [first])).toEqual({ ok: true, eventCount: 1 })
    expect(inspectCustodyChain({ ...header, headerHash: "ef".repeat(32) }, origin, [first])).toEqual({
      ok: false,
      brokenSeq: 0,
      reason: "header",
    })
    expect(inspectCustodyChain({ ...header, createdBy: "someone-else" }, origin, [first])).toEqual({
      ok: false,
      brokenSeq: 0,
      reason: "header",
    })
    expect(inspectCustodyChain({ ...header, createdAt: "2026-02-01T00:00:00.000Z" }, origin, [first])).toEqual({
      ok: false,
      brokenSeq: 0,
      reason: "header",
    })
    expect(inspectCustodyChain({ ...header, documentId: "doc-forged" }, origin, [first])).toEqual({
      ok: false,
      brokenSeq: 0,
      reason: "header",
    })
    expect(inspectCustodyChain({ ...header, custodian: "someone-else" }, origin, [first])).toEqual({
      ok: false,
      brokenSeq: 0,
      reason: "header",
    })
  })

  it("documentId matches the last link event and a later handling event does not clear it", () => {
    const row = item({ eventCount: 2, documentId: "doc-1" })
    const origin = genesis(row)
    const linkBody = {
      evidenceId: row.id,
      firmId: row.firmId,
      matterId: row.matterId,
      seq: 1,
      kind: "link" as const,
      actorId: row.createdBy,
      at: "2026-01-15T01:00:00.000Z",
      note: "ab".repeat(32),
      custodian: row.custodian,
      documentId: "doc-1",
      classification: "internal" as const,
      prevHash: origin.hash,
    }
    const link = event({ ...linkBody, id: "ev1_1", hash: custodyEventHash(linkBody) })
    const handlingBody = {
      ...linkBody,
      seq: 2,
      kind: "handling" as const,
      documentId: null,
      note: "moved",
      at: "2026-01-15T02:00:00.000Z",
      prevHash: link.hash,
    }
    const handling = event({ ...handlingBody, id: "ev1_2", hash: custodyEventHash(handlingBody) })
    const header = { ...row, headerHash: origin.hash, lastHash: handling.hash, documentId: "doc-1" }
    expect(inspectCustodyChain(header, origin, [link, handling])).toEqual({ ok: true, eventCount: 2 })
    expect(inspectCustodyChain({ ...header, documentId: null }, origin, [link, handling])).toEqual({
      ok: false,
      brokenSeq: 1,
      reason: "header",
    })
  })

  it("a duplicate seq fails even when the second copy would chain", () => {
    const row = item({ eventCount: 1 })
    const origin = genesis(row)
    const first = event({ prevHash: origin.hash })
    const copyBody = { ...first, id: "ev1_1b" }
    const { id: _id, hash: _hash, ...body } = copyBody
    const copy = { ...copyBody, hash: custodyEventHash(body) }
    const header = { ...row, headerHash: origin.hash, lastHash: copy.hash }
    expect(inspectCustodyChain(header, origin, [first, copy])).toEqual({ ok: false, brokenSeq: 1, reason: "duplicate" })
  })

  it("an event id that is not evidenceId_seq fails as identity, not as a hash miss", () => {
    const row = item({ eventCount: 1 })
    const origin = genesis(row)
    const first = event({ prevHash: origin.hash, id: "ev1_9" })
    const header = { ...row, headerHash: origin.hash, lastHash: first.hash }
    expect(inspectCustodyChain(header, origin, [first])).toEqual({ ok: false, brokenSeq: 1, reason: "identity" })
  })

  it("a link whose prevHash was recomputed to a foreign digest fails as prev", () => {
    const row = item({ eventCount: 1 })
    const origin = genesis(row)
    const foreign = "12".repeat(32)
    const body = {
      evidenceId: row.id,
      firmId: row.firmId,
      matterId: row.matterId,
      seq: 1,
      kind: "link" as const,
      actorId: row.createdBy,
      at: "2026-01-15T01:00:00.000Z",
      note: "ab".repeat(32),
      custodian: row.custodian,
      documentId: "doc-1",
      classification: "internal" as const,
      prevHash: foreign,
    }
    const link = event({ ...body, id: "ev1_1", hash: custodyEventHash(body) })
    const header = { ...row, headerHash: origin.hash, lastHash: link.hash, documentId: "doc-1" }
    expect(inspectCustodyChain(header, origin, [link])).toEqual({ ok: false, brokenSeq: 1, reason: "prev" })
  })

  it("the header and the trail are one transactional read, and export does not take a second", () => {
    const custodySrc = readFileSync(new URL("../src/d1/evidence/custody.ts", import.meta.url), "utf8")
    const exportSrc = readFileSync(new URL("../src/d1/evidence/export.ts", import.meta.url), "utf8")
    const start = custodySrc.indexOf("async function loadCustody")
    const end = custodySrc.indexOf("export async function getCustodyTrail")
    const body = custodySrc.slice(start, end)
    expect(body).toContain("runTransaction")
    expect(body).toContain("readItem(caller, id, mode, tx)")
    expect(body.match(/readChain\(item, tx\)/g)).toEqual(["readChain(item, tx)"])
    expect(custodySrc.match(/readChain\(item, tx\)/g)).toHaveLength(2)
    expect(custodySrc).not.toMatch(/readChain\(item\)/)
    expect(exportSrc.match(/await getCustodyTrail\(/g)).toHaveLength(1)
    expect(exportSrc).not.toMatch(/getEvidenceItem|readItem\(|readChain\(/)
  })
})
