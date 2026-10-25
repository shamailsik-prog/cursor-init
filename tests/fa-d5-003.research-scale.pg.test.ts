/**
 * FA-D5-003-R1-001: keyword /research over 25k+ visible judgments uses the published term index and
 * treatments for the top k only; a full-corpus load still hits row_cap.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  FA_D5_003_SUITE,
  type ResearchDb,
  bulkInsertVisibleJudgments,
  createResearchDb,
  refreshResearchTerms,
} from "@/tests/helpers/fa-d5-003-corpus"
import { searchResearch } from "@/services/d5-1/research"

const SCALE = 25_001
const MARKER = "fad5003scale25k"

describe.runIf(FA_D5_003_SUITE)("FA-D5-003-R1-001 research scale on Postgres", () => {
  let db: ResearchDb

  beforeAll(async () => {
    db = await createResearchDb("scale25k")
    await bulkInsertVisibleJudgments(db.admin, SCALE, MARKER)
    await refreshResearchTerms(db.writerUrl)
  }, 600_000)

  afterAll(async () => {
    await db?.drop()
  })

  it("searchResearch succeeds above the 20k judgment row cap; load() still refuses row_cap", async () => {
    const mod = await import("@/platform/corpus/pgResearchCorpus")
    const cfgMod = await import("@/functions/src/d4/corpusReaderConfig")
    const configured = cfgMod.readCorpusReaderConfig(
      { SIKANDER_CORPUS_READER_URL: db.researchUrl, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" },
      false
    )
    if (!configured.ok) throw new Error(`config refused: ${configured.reason}`)
    const store = new mod.PgResearchCorpus(configured.config)
    try {
      const targetOrd = 24_999
      const found = await searchResearch(store, { text: `${MARKER} ordinal ${targetOrd}`, k: 3 })
      expect(found.items.length).toBeGreaterThan(0)
      expect(found.items.some((h) => h.title.includes(`ordinal ${targetOrd}`))).toBe(true)

      let loadReason = "loaded"
      try {
        await store.load(() => ({ vectors: false }))
      } catch (e) {
        loadReason = String((e as { reason?: unknown }).reason ?? (e as Error).message)
      }
      expect(loadReason).toBe("row_cap")
    } finally {
      mod.resetResearchCorpusIdfCacheForTests()
      await store.end()
    }
  }, 120_000)
})
