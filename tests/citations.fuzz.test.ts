// Review round 2, N1: property-based fuzz of the citation gate. For each seeded OVERRULED
// authority, ≥ 2,000 deterministic variants (seeded RNG) insert random code points from \p{M},
// \p{Cf}, \p{Zs} and \p{Pd}, swap the digit script and the dash/space type, add Markdown/HTML
// markup and wrap lines. Properties:
//   1. the gate never returns OK for a variant (nothing evades without a partner override);
//   2. no variant yields a VERIFIED finding (nothing resolves to a different authority —
//      verified look-alike decoys with neighbouring pages are seeded);
//   3. compose through /api/d4/drafts never returns 200 without a partner override.
// Review round 3 (item 10) adds operations for: UTS #39 confusable substitution (the committed
// ASCII subset), bidi wrappers (RLO/RLE/RLI/FSI, with and without reversal), thousands-style
// punctuation inside a number, bare "<" / ">" in the surrounding prose, \p{Zl} / \p{Zp} /
// \p{Cc} insertion, case flips and Urdu-script reporter spellings. The gate properties now run
// the production pipeline: each variant is refused by the charset layer (422
// unsupported_characters) or, once normalised, blocked by the gate — and compose answers 422.
// Seed: CITATION_FUZZ_SEED (default committed below) so failures reproduce exactly.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { POST as DRAFTS } from "@/app/api/d4/drafts/route"
import { getRuntimeStore, resetRuntimeStoreForTests } from "@/platform/spine/runtimeStore"
import { newStore, type SpineStore } from "@/platform/spine/store"
import { addMember, createMatter } from "@/services/d1-2/matters"
import { URDU_REPORTER_SPELLINGS, extractCitations } from "@/services/d4-2/citations"
import { checkDraftCharset } from "@/services/d4-2/draftCharset"
import confusables from "@/data/confusables-ascii-subset.json"
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

type Pools = {
  M: number[]; Cf: number[]; Zs: number[]; Pd: number[]; ndZeros: number[]
  /** \p{Zl}, \p{Zp} and \p{Cc} (R3 item 10) */
  lineCc: number[]
  /** ASCII character -> code points UTS #39 maps onto it (single-character prototypes) */
  confusableOf: Map<string, number[]>
}

function buildPools(): Pools {
  const pools: Pools = { M: [], Cf: [], Zs: [], Pd: [0x2212], ndZeros: [], lineCc: [], confusableOf: new Map() }
  for (const [hex, prototype] of Object.entries((confusables as { map: Record<string, string> }).map)) {
    if (prototype.length !== 1) continue
    const list = pools.confusableOf.get(prototype) ?? []
    list.push(Number.parseInt(hex, 16))
    pools.confusableOf.set(prototype, list)
  }
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const ch = String.fromCodePoint(cp)
    if (/\p{M}/u.test(ch)) pools.M.push(cp)
    else if (/\p{Cf}/u.test(ch)) pools.Cf.push(cp)
    else if (/\p{Zs}/u.test(ch)) pools.Zs.push(cp)
    else if (/\p{Pd}/u.test(ch)) pools.Pd.push(cp)
    else if (/\p{Nd}/u.test(ch) && !/\p{Nd}/u.test(String.fromCodePoint(cp - 1))) pools.ndZeros.push(cp)
    else if (/[\p{Zl}\p{Zp}\p{Cc}]/u.test(ch)) pools.lineCc.push(cp)
  }
  return pools
}

const MARKUP: Array<[string, string]> = [
  ["*", "*"], ["**", "**"], ["_", "_"], ["__", "__"], ["`", "`"], ["~~", "~~"],
  ["<i>", "</i>"], ["<b>", "</b>"], ["<span class=\"c\">", "</span>"], ["&nbsp;", ""],
]

const BIDI_WRAPPERS: Array<[string, string]> = [
  ["\u202e", "\u202c"], ["\u202b", "\u202c"], ["\u2067", "\u2069"], ["\u2068", "\u2069"], ["\u202d", "\u202c"],
]
const THOUSANDS = [",", ".", "'", "\u2019", "\u066c", "\u2009", "\u202f"]
const PROSE_ANGLES = ["where loss < 5% ", " and > 5% ", "<", ">", "a < b ", " c > d", "<- ", " ->"]
const URDU_TOKENS = Object.keys(URDU_REPORTER_SPELLINGS).sort((a, b) => b.length - a.length)

function variant(base: string, rnd: () => number, pools: Pools): string {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
  let cps = [...base]
  const ops = 1 + Math.floor(rnd() * 5)
  for (let k = 0; k < ops; k += 1) {
    const op = Math.floor(rnd() * 15)
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
    } else if (op === 7) {
      // wrap a line at a space
      const spaces = cps.flatMap((c, i) => (c === " " ? [i] : []))
      if (spaces.length) cps[pick(spaces)] = rnd() < 0.5 ? "\n" : "\r\n"
    } else if (op === 8) {
      // UTS #39 confusable substitution for 1-3 characters
      const slots = cps.flatMap((c, i) => (pools.confusableOf.has(c) ? [i] : []))
      for (let n = 1 + Math.floor(rnd() * 3); n > 0 && slots.length; n -= 1) {
        const i = slots.splice(Math.floor(rnd() * slots.length), 1)[0] ?? 0
        const lookalikes = pools.confusableOf.get(cps[i] ?? "")
        if (lookalikes) cps[i] = String.fromCodePoint(pick(lookalikes))
      }
    } else if (op === 9) {
      // bidi wrapper around a token or the whole run, with or without visual reversal
      const text = cps.join("")
      const tokens = [...text.matchAll(/\S+/g)]
      const [open, close] = pick(BIDI_WRAPPERS)
      const whole = rnd() < 0.4 || tokens.length === 0
      const s0 = whole ? 0 : (pick(tokens).index ?? 0)
      const len = whole ? text.length : (text.slice(s0).match(/^\S+/)?.[0].length ?? 0)
      const inner = text.slice(s0, s0 + len)
      const shown = rnd() < 0.7 ? [...inner].reverse().join("") : inner
      cps = [...(text.slice(0, s0) + open + shown + close + text.slice(s0 + len))]
    } else if (op === 10) {
      // thousands-style punctuation inside a number
      const text = cps.join("")
      const runs = [...text.matchAll(/[0-9]{2,}/g)]
      if (runs.length) {
        const r = rnd() < 0.7 ? runs[runs.length - 1]! : pick(runs)
        const digits = r[0].length
        const cut = digits >= 4 && rnd() < 0.6 ? digits - 3 : 1 + Math.floor(rnd() * (digits - 1))
        const s0 = (r.index ?? 0) + cut
        cps = [...(text.slice(0, s0) + pick(THOUSANDS) + text.slice(s0))]
      }
    } else if (op === 11) {
      // bare "<" / ">" in the prose around (within 80 characters of) the citation
      // (a multi-character prose fragment goes before or after the citation — spliced between its
      // letters it would change what a reader sees; a single "<" / ">" goes anywhere)
      const angle = pick(PROSE_ANGLES)
      if (angle.length === 1) cps.splice(at, 0, angle)
      else if (rnd() < 0.5) cps = [...angle.trim(), " ", ...cps]
      else cps.push(" ", ...angle.trim())
    } else if (op === 12) {
      // a line/paragraph separator or a control character
      cps.splice(at, 0, String.fromCodePoint(pick(pools.lineCc)))
    } else if (op === 13) {
      // case flips
      for (let i = 0; i < cps.length; i += 1) {
        const c = cps[i] ?? ""
        if (/^[A-Za-z]$/.test(c) && rnd() < 0.5) cps[i] = c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()
      }
    } else {
      // Urdu-script reporter spelling (optionally Urdu digits too)
      let text = cps.join("")
      const token = URDU_TOKENS.find((t) => text.includes(t))
      if (token) {
        text = text.replace(token, URDU_REPORTER_SPELLINGS[token] ?? token)
        if (rnd() < 0.5) text = text.replace(/[0-9]/g, (d) => String.fromCodePoint(0x06f0 + Number(d)))
        cps = [...text]
      }
    }
  }
  return cps.join("")
}

/**
 * True when the gate's findings are all VERIFIED and every one is stated in the normalised text
 * as "<ref>, <digits>" with a plain space — the pinpoint form the round-3 ruling keeps ("2019
 * SCMR 1, 234" reads page 1 pinpoint 234; the stored body says exactly that).
 */
function isRuledPinpointOnly(normalised: string, findings: Array<{ ref: string; status: string }>): boolean {
  return findings.every((f) => {
    if (f.status !== "VERIFIED") return false
    const pattern = f.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")
    return new RegExp(`(?<![0-9A-Za-z])${pattern}, [0-9]`, "i").test(normalised)
  })
}

const codePoints = (text: string) => [...text].map((c) => (c.codePointAt(0) ?? 0).toString(16)).join(" ")

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
    let refused = 0
    let blocked = 0
    let pinpoints = 0
    for (let i = 0; i < VARIANTS_PER_CITATION; i += 1) {
      const text = `Relying on ${variant(cite, rnd, pools)} for the proposition.`
      // production pipeline: charset refusal first, then the gate on the normalised body
      const check = checkDraftCharset(text)
      if (!check.ok) {
        refused += 1
        continue
      }
      const res = verifyCitations(store, extractCitations(check.normalised))
      // A VERIFIED finding that the normalised body states as "<ref>, <digits>" is the ruled
      // ", 1240" pinpoint form — what the stored text literally says, not another authority.
      if (res.findings.some((f) => f.status === "VERIFIED") && isRuledPinpointOnly(check.normalised, res.findings)) {
        pinpoints += 1
        continue
      }
      if (res.status === "OK" || res.findings.some((f) => f.status === "VERIFIED")) {
        throw new Error(
          `seed ${SEED} variant #${i} evaded: ${JSON.stringify(text)} [${codePoints(text)}] -> ${JSON.stringify(res)}`
        )
      }
      blocked += 1
    }
    // both outcomes must actually occur, or the property is vacuous for one of them
    expect(refused).toBeGreaterThan(0)
    expect(blocked).toBeGreaterThan(VARIANTS_PER_CITATION / 10)
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
        // refused (422 unsupported_characters) or blocked by the gate (422) — never anything else
        const stored = checkDraftCharset(body)
        if (res.status === 200 && stored.ok) {
          const gate = verifyCitations(store, extractCitations(stored.normalised))
          if (gate.findings.some((f) => f.status === "VERIFIED") && isRuledPinpointOnly(stored.normalised, gate.findings)) {
            store.drafts.clear()
            continue
          }
        }
        if (res.status !== 422) {
          throw new Error(`seed ${SEED} compose variant #${i} returned ${res.status}: ${JSON.stringify(body)} [${codePoints(body)}]`)
        }
      }
      expect([...store.drafts.values()]).toHaveLength(0)
    }, 120_000)
  })
})
