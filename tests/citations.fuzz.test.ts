// Review round 2, N1: property-based fuzz of the citation gate. For each seeded OVERRULED
// authority, ≥ 2,000 deterministic variants (seeded RNG) insert random code points from \p{M},
// \p{Cf}, \p{Zs} and \p{Pd}, swap the digit script and the dash/space type, add Markdown/HTML
// markup and wrap lines. Properties:
//   1. the gate never returns OK for a variant (nothing evades without a partner override);
//   2. no variant yields a VERIFIED finding (nothing resolves to a different authority —
//      verified look-alike decoys with neighbouring pages are seeded);
//   3. compose through /api/d4/drafts never returns 200 without a partner override.
// Seed: CITATION_FUZZ_SEED (default committed below) so failures reproduce exactly.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { newStore, type SpineStore } from "@/platform/spine/store"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { extractCitations } from "@/services/d4-2/citations"
import { seedJudgment, seedTreatment, verifyCitations } from "@/services/d4-2/draftingIntelligence"
import { getDocumentTypes } from "@/lib/foundation-data"

const SEED = Number.parseInt(process.env.CITATION_FUZZ_SEED ?? "20261006", 10)
const VARIANTS_PER_CITATION = 2000
const COMPOSE_VARIANTS = 2000

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Pools = { M: number[]; Cf: number[]; Zs: number[]; Pd: number[]; ndZeros: number[] }

function buildPools(): Pools {
  const pools: Pools = { M: [], Cf: [], Zs: [], Pd: [0x2212], ndZeros: [] }
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const ch = String.fromCodePoint(cp)
    if (/\p{M}/u.test(ch)) pools.M.push(cp)
    else if (/\p{Cf}/u.test(ch)) pools.Cf.push(cp)
    else if (/\p{Zs}/u.test(ch)) pools.Zs.push(cp)
    else if (/\p{Pd}/u.test(ch)) pools.Pd.push(cp)
    else if (/\p{Nd}/u.test(ch) && !/\p{Nd}/u.test(String.fromCodePoint(cp - 1))) pools.ndZeros.push(cp)
  }
  return pools
}

const MARKUP: Array<[string, string]> = [
  ["*", "*"], ["**", "**"], ["_", "_"], ["__", "__"], ["`", "`"], ["~~", "~~"],
  ["<i>", "</i>"], ["<b>", "</b>"], ["<span class=\"c\">", "</span>"], ["&nbsp;", ""],
]

function variant(base: string, rnd: () => number, pools: Pools): string {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  let cps = [...base]
  const ops = 1 + Math.floor(rnd() * 5)
  for (let k = 0; k < ops; k += 1) {
    const op = Math.floor(rnd() * 8)
    const at = Math.floor(rnd() * (cps.length + 1))
    if (op <= 3) {
      // insert a random code point from \p{M} / \p{Cf} / \p{Zs} / \p{Pd}
      const pool = [pools.M, pools.Cf, pools.Zs, pools.Pd][op] ?? pools.M
      cps.splice(at, 0, String.fromCodePoint(pick(pool)))
    } else if (op === 4) {
      // swap the digit script of every ASCII digit
      const zero = pick(pools.ndZeros)
      cps = cps.map((c) => (/^[0-9]$/.test(c) ? String.fromCodePoint(zero + Number(c)) : c))
    } else if (op === 5) {
      // swap one separator space for a random dash or blank
      const spaces = cps.flatMap((c, i) => (c === " " ? [i] : []))
      if (spaces.length) cps[pick(spaces)] = String.fromCodePoint(pick(rnd() < 0.5 ? pools.Pd : pools.Zs))
    } else if (op === 6) {
      // markup around a token, or a stray markup character anywhere
      const text = cps.join("")
      const tokens = [...text.matchAll(/\S+/g)]
      const [open, close] = pick(MARKUP)
      if (tokens.length && rnd() < 0.7) {
        const t = pick(tokens)
        const s = t.index ?? 0
        cps = [...(text.slice(0, s) + open + t[0] + close + text.slice(s + t[0].length))]
      } else {
        cps.splice(at, 0, ...open)
      }
    } else {
      // wrap a line at a space
      const spaces = cps.flatMap((c, i) => (c === " " ? [i] : []))
      if (spaces.length) cps[pick(spaces)] = rnd() < 0.5 ? "\n" : "\r\n"
    }
  }
  return cps.join("")
}

const OVERRULED = ["2019 SCMR 1234", "PLD 2010 Lahore 5", "2018 CLC 789", "2019 PCrLJ 44"]
const DECOYS = [
  "2019 SCMR 1", "2019 SCMR 12", "2019 SCMR 123", "2019 SCMR 234", "2019 SCMR 34", "2019 SCMR 4", "2019 SCMR 12345",
  "PLD 2010 Lahore 50", "PLD 2010 Lahore 55", "PLD 2010 SC 5", "2010 PLD 5",
  "2018 CLC 78", "2018 CLC 7", "2018 CLC 89", "2018 CLC 7890",
  "2019 PCrLJ 4", "2019 PCrLJ 444", "2019 PCrLJ 4400",
  "2001 SCMR 1234", "2019 SCR 1234", "2019 CLC 1234",
]

function seedAuthorities(store: SpineStore) {
  seedJudgment(store, "j-larger", "Larger bench", "larger", "2025 SCMR 999")
  OVERRULED.forEach((cite, i) => {
    seedJudgment(store, `j-over-${i}`, cite, "single", cite)
    seedTreatment(store, "j-larger", `j-over-${i}`, "overruled", "larger")
  })
  DECOYS.forEach((cite, i) => seedJudgment(store, `decoy-${i}`, cite, "full", cite))
}

let pools: Pools
beforeAll(() => {
  pools = buildPools()
})

describe(`citation gate fuzz (seed ${SEED})`, () => {
  it.each(OVERRULED)(`%s: ${VARIANTS_PER_CITATION} variants never OK and never VERIFIED`, (cite) => {
    const store = newStore()
    seedAuthorities(store)
    const rnd = mulberry32(SEED ^ [...cite].reduce((h, c) => Math.imul(h, 31) + (c.codePointAt(0) ?? 0), 7))
    for (let i = 0; i < VARIANTS_PER_CITATION; i += 1) {
      const text = `Relying on ${variant(cite, rnd, pools)} for the proposition.`
      const res = verifyCitations(store, extractCitations(text))
      if (res.status === "OK" || res.findings.some((f) => f.status === "VERIFIED")) {
        throw new Error(
          `seed ${SEED} variant #${i} evaded: ${JSON.stringify(text)} -> ${JSON.stringify(res)}`
        )
      }
    }
  })

  describe("compose never returns 200 without a partner override", () => {
    afterAll(() => resetRuntimeStoreForTests())
    it(`${COMPOSE_VARIANTS} variants of 2019 SCMR 1234 through /api/d4/drafts`, async () => {
      resetRuntimeStoreForTests()
      const store = getRuntimeStore()
      const m = createMatter(store, { firmId: "firmA", clientId: "client_a", title: "t", courtId: "SHC", classification: "internal" })
      addMember(store, m.id, "associate_a", "firmA")
      seedAuthorities(store)
      const templateId = getDocumentTypes()[0]!.id
      const rnd = mulberry32(SEED + 1)
      for (let i = 0; i < COMPOSE_VARIANTS; i += 1) {
        const body = `Relying on ${variant("2019 SCMR 1234", rnd, pools)}.`
        const res = await DRAFTS(
          new Request("http://127.0.0.1/api/d4/drafts", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `f0f0f0f0-0000-4000-8000-${String(i).padStart(12, "0")}`,
            },
            body: JSON.stringify({
              action: "compose", actorId: "associate_a", matterId: m.id, templateId,
              title: "x", body, classification: "internal",
            }),
          })
        )
        if (res.status === 200) {
          throw new Error(`seed ${SEED} compose variant #${i} returned 200: ${JSON.stringify(body)}`)
        }
      }
      expect([...store.drafts.values()]).toHaveLength(0)
    }, 120_000)
  })
})
