import { describe, expect, it } from "vitest"
import { matchingNames } from "../src/d1/conflict/candidates"
import { NAME_THRESHOLD, nameScore, screen, type Candidate, type Subject } from "../src/d1/conflict/match"
import { NAME_INDEX_CHUNK_BYTES, NAME_INDEX_MAX_CHUNKS, NAME_INDEX_SCHEMA, nameBytes, nameIndexProblem, placeNames } from "../src/d1/conflict/nameIndex"
import { nameForms, usesFallback } from "../src/d1/conflict/normalise"
import type { RegistryState } from "../src/d1/registryVersion"

/** Audit F37: the pure parts of the name index and the name tier (no emulator). */

const state = (over: Omit<Partial<RegistryState>, "nameIndex"> & { nameIndex?: Partial<RegistryState["nameIndex"]> } = {}): RegistryState => ({
  exists: true,
  version: 7,
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
