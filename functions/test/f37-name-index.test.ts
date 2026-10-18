import { describe, expect, it } from "vitest"
import { concurrencyLimit, IN_LIMIT, inLists, matchingNames } from "../src/d1/conflict/candidates"
import { NAME_THRESHOLD, nameScore, screen, type Candidate, type Subject } from "../src/d1/conflict/match"
import { indexedNamesOf, NAME_INDEX_CHUNK_BYTES, NAME_INDEX_MAX_CHUNKS, NAME_INDEX_SCHEMA, nameBytes, nameIndexProblem, placeNames } from "../src/d1/conflict/nameIndex"
import { chunkWriteVerdict, rowWriteVerdict } from "../src/d1/conflict/registryTriggers"
import { nameForms, usesFallback } from "../src/d1/conflict/normalise"
import { nameIndexGenOf, registryStateOf, type RegistryState } from "../src/d1/registryVersion"

/** Audit F37: the pure parts of the name index and the name tier (no emulator). */

const state = (over: Omit<Partial<RegistryState>, "nameIndex"> & { nameIndex?: Partial<RegistryState["nameIndex"]> } = {}): RegistryState => ({
  exists: true,
  version: 7,
  nameIndexGen: 0,
  nameIndexEpoch: 0,
  ...over,
  nameIndex: { schema: NAME_INDEX_SCHEMA, version: 7, chunk: 0, bytes: 10, valid: true, ...over.nameIndex },
})

describe("nameIndexProblem: when a screen may use the index", () => {
  it("current only with the schema and the mirror equal to the version", () => {
    expect(nameIndexProblem(state())).toBeNull()
    expect(nameIndexProblem(state({ nameIndex: { schema: null } }))).toBe("missing")
    expect(nameIndexProblem(state({ nameIndex: { schema: NAME_INDEX_SCHEMA + 1 } }))).toBe("schema")
    expect(nameIndexProblem(state({ nameIndex: { version: 6 } }))).toBe("stale")
    expect(nameIndexProblem(state({ nameIndex: { version: null } }))).toBe("stale")
    expect(nameIndexProblem(state({ nameIndex: { valid: false } }))).toBe("corrupt")
    expect(nameIndexProblem(state({ nameIndex: { chunk: NAME_INDEX_MAX_CHUNKS } }))).toBe("corrupt")
    // The placement opens a chunk only to put a name in it: an open chunk past 0 with no bytes is impossible.
    expect(nameIndexProblem(state({ nameIndex: { chunk: 2, bytes: 0 } }))).toBe("corrupt")
  })
})

describe("registryStateOf: the stored nameIndex map is read whole or not at all (PR #80 review)", () => {
  const parsed = (nameIndex: unknown) => registryStateOf(true, { version: 7, nameIndex }).nameIndex

  it("no map is an index never built; a whole map is read as stored", () => {
    expect(parsed(undefined)).toEqual({ schema: null, version: null, chunk: 0, bytes: 0, valid: true })
    expect(parsed({ schema: NAME_INDEX_SCHEMA, version: 7, chunk: 2, bytes: 10 })).toEqual({ schema: NAME_INDEX_SCHEMA, version: 7, chunk: 2, bytes: 10, valid: true })
  })

  it("with a schema, chunk and bytes are required: a missing one is corrupt, never 0", () => {
    expect(parsed({ schema: NAME_INDEX_SCHEMA, version: 7, bytes: 10 }).valid).toBe(false)
    expect(parsed({ schema: NAME_INDEX_SCHEMA, version: 7, chunk: 2 }).valid).toBe(false)
    expect(nameIndexProblem(registryStateOf(true, { version: 7, nameIndex: { schema: NAME_INDEX_SCHEMA, version: 7, bytes: 10 } }))).toBe("corrupt")
    expect(nameIndexProblem(registryStateOf(true, { version: 7, nameIndex: { schema: NAME_INDEX_SCHEMA, version: 7, chunk: 2 } }))).toBe("corrupt")
  })

  it("the mirror version is required (every writer writes it)", () => {
    expect(parsed({ schema: NAME_INDEX_SCHEMA, chunk: 0, bytes: 0 }).valid).toBe(false)
    expect(parsed({ chunk: 0, bytes: 0 }).valid).toBe(false)
  })

  it("without a schema, chunk and bytes come together or not at all (a pre-F37 firm's mirror-only bump has neither)", () => {
    expect(parsed({ version: 3 })).toEqual({ schema: null, version: 3, chunk: 0, bytes: 0, valid: true })
    expect(parsed({ version: 3, chunk: 1, bytes: 5 })).toEqual({ schema: null, version: 3, chunk: 1, bytes: 5, valid: true })
    expect(parsed({ version: 3, chunk: 1 }).valid).toBe(false)
    expect(parsed({ version: 3, bytes: 5 }).valid).toBe(false)
  })

  it("any malformed value is corrupt", () => {
    for (const bad of [
      null,
      [],
      "x",
      { schema: NAME_INDEX_SCHEMA, version: 7, chunk: -1, bytes: 0 },
      { schema: NAME_INDEX_SCHEMA, version: 7, chunk: 1.5, bytes: 4 },
      { schema: String(NAME_INDEX_SCHEMA), version: 7, chunk: 0, bytes: 0 },
      { schema: NAME_INDEX_SCHEMA, version: "7", chunk: 0, bytes: 0 },
      { schema: NAME_INDEX_SCHEMA, version: 7, chunk: 0, bytes: null },
    ]) {
      expect(parsed(bad).valid, JSON.stringify(bad)).toBe(false)
    }
  })
})

describe("placeNames: chunks never pass their byte budget", () => {
  it("counts UTF-8 bytes plus one per name and opens the next chunk before the budget would be passed", () => {
    expect(nameBytes("ali")).toBe(4)
    expect(nameBytes("علی")).toBe(7)
    const p = placeNames({ chunk: 2, bytes: 100 }, ["a b", "a b", "c"])
    expect([...p.byChunk]).toEqual([[2, ["a b", "c"]]])
    expect([p.chunk, p.bytes]).toEqual([2, 100 + 4 + 2])
    const full = placeNames({ chunk: 0, bytes: NAME_INDEX_CHUNK_BYTES - 3 }, ["xy", "xyz"])
    expect([...full.byChunk]).toEqual([[0, ["xy"]], [1, ["xyz"]]])
    expect([full.chunk, full.bytes]).toEqual([1, 4])
  })
  it("a long run of names fills chunk after chunk, each within the budget", () => {
    const names = Array.from({ length: 60_000 }, (_, i) => `name number ${i} with some length`)
    const p = placeNames({ chunk: 0, bytes: 0 }, names)
    expect(p.byChunk.size).toBeGreaterThan(3)
    for (const list of p.byChunk.values()) expect(list.reduce((sum, n) => sum + nameBytes(n), 0)).toBeLessThanOrEqual(NAME_INDEX_CHUNK_BYTES)
    expect([...p.byChunk.values()].flat()).toEqual(names)
  })
})

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ["muhammad", "mohd", "ali", "aly", "rehman", "rahman", "rehmn", "abdul", "abdulrehman", "haris", "harris", "qalbani", "qalbany", "khan", "syed", "محمد", "علی", "قلبانی", "زروانی", "traders", "sons"]
const candidate = (name: string): Candidate => ({
  role: "client", name, forms: nameForms(name), keys: {}, matterId: null, matterNo: null, matterClassification: "internal",
  matterStatus: null, clientHasLiveMatter: false, linkState: "none", linkIds: [], unresolvedLinkIds: [],
})

describe("the name tier asks the engine's own question", () => {
  it("for 3,000 random pairs, screen() makes a keyless name hit exactly when nameScore ≥ the threshold (fallback subjects included)", () => {
    const r = prng(37)
    const name = () => Array.from({ length: 1 + Math.floor(r() * 3) }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ")
    let hits = 0
    for (let i = 0; i < 3000; i++) {
      const subject: Subject = { role: "opposing", name: name(), keys: {} }
      const c = candidate(name())
      const fallback = usesFallback(subject.name)
      const out = screen([subject], [nameForms(subject.name)], [c], { subjectFallback: [fallback], subjectEntityIds: [undefined] })
      const expected = nameScore(nameForms(subject.name), c.forms, fallback) >= NAME_THRESHOLD
      expect([subject.name, c.name, out.hits.length === 1]).toEqual([subject.name, c.name, expected])
      if (expected) hits += 1
    }
    expect(hits).toBeGreaterThan(300)
  })

  it("matchingNames keeps exactly the names some subject can hit: typos and concatenations with no shared token included", () => {
    const subjects: Subject[] = [
      { role: "client", name: "Haris Qalbani", keys: {} },
      { role: "opposing", name: "Abdul Rehman", keys: {} },
    ]
    // "قلبانی حارث" reads "qlbany hars" through the lossy fallback, which already scores 20/24 against "haris qalbani".
    const names = ["Harris Qalbany", "Abdulrehman", "Rehmn Abdul", "Zubair Hashmi", "قلبانی حارث", "Abdul Rehman Traders"]
    expect(matchingNames(names, subjects, new Map())).toEqual(["Harris Qalbany", "Abdulrehman", "Rehmn Abdul", "قلبانی حارث", "Abdul Rehman Traders"])
    // "زروانی" reads "zrwany" through the fallback (8/13 against "zarvani"); the firm map's spelling makes it match.
    const zarvani: Subject[] = [{ role: "opposing", name: "Zarvani", keys: {} }]
    expect(matchingNames(["زروانی"], zarvani, new Map())).toEqual([])
    expect(matchingNames(["زروانی"], zarvani, new Map([["زروانی", ["zarvani"]]]))).toEqual(["زروانی"])
  })
})

describe("inLists and the query cap (F37 re-audit FA-D1C-006: M05, INFO)", () => {
  it("every value lands in exactly one list of at most 30, in order, for 0 to 95 values", () => {
    for (let n = 0; n <= 95; n++) {
      const values = Array.from({ length: n }, (_, i) => `v${i}`)
      const lists = inLists(values)
      expect(lists.flat()).toEqual(values)
      expect(lists.every((l) => l.length >= 1 && l.length <= IN_LIMIT)).toBe(true)
      expect(lists.length).toBe(Math.ceil(n / IN_LIMIT))
    }
  })

  it("concurrencyLimit never runs more than its maximum at once and runs every task", async () => {
    const run = concurrencyLimit(3)
    let active = 0
    let peak = 0
    const done = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        run(async () => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((r) => setTimeout(r, 2 + (i % 4)))
          active -= 1
          return i
        })
      )
    )
    expect(done).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(peak).toBe(3)
  })
})

describe("indexedNamesOf: every chunk of the firm, none beyond the pointer (F37 re-audit FA-D1C-001)", () => {
  const firm = "firm-x"
  const chunk = (n: number, names: string[], over: Record<string, unknown> = {}) => ({ id: `${firm}_${n}`, data: { firmId: firm, chunk: n, names, ...over } })
  const at = (chunkN: number, bytes: number) => state({ nameIndex: { chunk: chunkN, bytes } })

  it("reads chunks 0..pointer whole", () => {
    expect([...indexedNamesOf(firm, at(1, 14), [chunk(0, ["Tariq Zarvani"]), chunk(1, ["Haris Qalbani"])])].sort()).toEqual(["Haris Qalbani", "Tariq Zarvani"])
  })

  it("a chunk of the firm beyond the pointer (a lowered pointer, with or without a gap) is corrupt", () => {
    expect(() => indexedNamesOf(firm, at(0, 14), [chunk(0, ["Tariq Zarvani"]), chunk(1, ["Haris Qalbani"])])).toThrow(expect.objectContaining({ reason: "corrupt" }))
    expect(() => indexedNamesOf(firm, at(0, 14), [chunk(0, ["Tariq Zarvani"]), chunk(2, ["Haris Qalbani"])])).toThrow(expect.objectContaining({ reason: "corrupt" }))
  })

  it("another firm's documents whose ids share the prefix are not this firm's chunks", () => {
    const other = { id: `${firm}_7_0`, data: { firmId: `${firm}_7`, chunk: 0, names: ["Omer Daryani"] } }
    expect([...indexedNamesOf(firm, at(0, 14), [chunk(0, ["Tariq Zarvani"]), other])]).toEqual(["Tariq Zarvani"])
  })
})

describe("the registry triggers' verdicts (F37 re-audit FA-D1C-002, FA-D1C-004)", () => {
  const firm = "firm-x"
  const GEN = 3
  const stamp = (name: string, firmId = firm, gen = GEN) => ({ nameIndexed: { firmId, name, gen } })
  const verdict = (collection: string, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) =>
    rowWriteVerdict(collection, before, after, GEN)

  it("a stamped new name is indexed; an unstamped, mis-stamped or other-firm-stamped one is unindexed", () => {
    expect(verdict("clients", undefined, { firmId: firm, canonicalName: "Haris Qalbani", ...stamp("Haris Qalbani") })).toBe("indexed")
    expect(verdict("clients", undefined, { firmId: firm, canonicalName: "Haris Qalbani" })).toBe("unindexed")
    expect(verdict("clients", undefined, { firmId: firm, canonicalName: "Haris Qalbani", ...stamp("Zubair Hashmi") })).toBe("unindexed")
    expect(verdict("clients", undefined, { firmId: firm, canonicalName: "Haris Qalbani", ...stamp("Haris Qalbani", "firm-y") })).toBe("unindexed")
    expect(verdict("matter_parties", undefined, { firmId: firm, role: "opposing", name: "Haris Qalbani", ...stamp("Haris Qalbani") })).toBe("indexed")
  })

  it("a stamp of another generation, without one, or against an unknown generation is not trusted (a rebuild may have dropped the name)", () => {
    const row = (nameIndexed: unknown) => ({ firmId: firm, canonicalName: "Haris Qalbani", nameIndexed })
    expect(verdict("clients", undefined, { ...row(undefined), ...stamp("Haris Qalbani", firm, GEN - 1) })).toBe("unindexed")
    expect(verdict("clients", undefined, { ...row(undefined), ...stamp("Haris Qalbani", firm, GEN + 1) })).toBe("unindexed")
    expect(verdict("clients", undefined, row({ firmId: firm, name: "Haris Qalbani" }))).toBe("unindexed")
    expect(verdict("clients", undefined, row({ firmId: firm, name: "Haris Qalbani", gen: "3" }))).toBe("unindexed")
    expect(rowWriteVerdict("clients", undefined, { ...row(undefined), ...stamp("Haris Qalbani") }, null)).toBe("unindexed")
    // A rename back to the stamped name is judged like any new name: its generation decides.
    const renamed = { ...row(undefined), ...stamp("Haris Qalbani", firm, GEN - 1), canonicalName: "Zubair Hashmi" }
    expect(verdict("clients", renamed, { ...renamed, canonicalName: "Haris Qalbani" })).toBe("unindexed")
  })

  it("the stored generation: absent is 0, a malformed one is unknown and makes the index state invalid", () => {
    expect(nameIndexGenOf(undefined)).toBe(0)
    expect(nameIndexGenOf({ version: 7 })).toBe(0)
    expect(nameIndexGenOf({ nameIndexGen: 4 })).toBe(4)
    for (const bad of [-1, 1.5, "4", {}]) expect(nameIndexGenOf({ nameIndexGen: bad })).toBeNull()
    const good = { version: 7, nameIndex: { schema: NAME_INDEX_SCHEMA, version: 7, chunk: 0, bytes: 10 } }
    expect(registryStateOf(true, { ...good, nameIndexGen: 2 })).toMatchObject({ nameIndexGen: 2, nameIndex: { valid: true } })
    expect(registryStateOf(true, { ...good, nameIndexGen: "2" })).toMatchObject({ nameIndexGen: 0, nameIndex: { valid: false } })
    expect(nameIndexProblem(registryStateOf(true, { ...good, nameIndexGen: "2" }))).toBe("corrupt")
  })

  it("a rename, a role flip to opposing and a move between firms set a new screened name", () => {
    const zubair = { firmId: firm, canonicalName: "Zubair Hashmi", ...stamp("Zubair Hashmi") }
    expect(verdict("clients", zubair, { ...zubair, canonicalName: "Haris Qalbani" })).toBe("unindexed")
    const party = { firmId: firm, role: "client", name: "Haris Qalbani" }
    expect(verdict("matter_parties", party, { ...party, role: "opposing" })).toBe("unindexed")
    const elsewhere = { firmId: "firm-y", canonicalName: "Haris Qalbani", ...stamp("Haris Qalbani", "firm-y") }
    expect(verdict("clients", elsewhere, { ...elsewhere, firmId: firm })).toBe("unindexed")
  })

  it("an edit that keeps the screened name (even on an unstamped, pre-trigger row), a deletion, and a row the screen cannot hit are unchanged", () => {
    const legacy = { firmId: firm, role: "opposing", name: "Haris Qalbani", matterStatus: "live" }
    expect(verdict("matter_parties", legacy, { ...legacy, matterStatus: "closed" })).toBe("unchanged")
    expect(verdict("clients", { firmId: firm, canonicalName: "Haris Qalbani" }, undefined)).toBe("unchanged")
    expect(verdict("matter_parties", undefined, { firmId: firm, role: "client", name: "Haris Qalbani" })).toBe("unchanged")
    expect(verdict("matter_parties", { firmId: firm, role: "opposing", name: "Haris Qalbani" }, { firmId: firm, role: "client", name: "Haris Qalbani" })).toBe("unchanged")
    expect(verdict("clients", undefined, { firmId: firm })).toBe("unchanged")
  })

  it("a chunk that loses a name is names_removed; appends, creates and deletes are ok", () => {
    const before = { firmId: firm, chunk: 0, names: ["Tariq Zarvani", "Haris Qalbani"] }
    expect(chunkWriteVerdict(before, { ...before, names: ["Tariq Zarvani"] })).toBe("names_removed")
    expect(chunkWriteVerdict(before, { ...before, names: [] })).toBe("names_removed")
    expect(chunkWriteVerdict(before, { ...before, names: "broken" })).toBe("names_removed")
    expect(chunkWriteVerdict(before, { ...before, names: [...before.names, "Omer Daryani"] })).toBe("ok")
    expect(chunkWriteVerdict(undefined, before)).toBe("ok")
    expect(chunkWriteVerdict(before, undefined)).toBe("ok")
  })
})

