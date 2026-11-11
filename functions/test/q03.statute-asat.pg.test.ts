/**
 * Q03 as-at characterisation. Annex A history is unchanged by the identity fix, so this file is
 * expected to pass on fa2f43e7 as well as on the head. Synthetic statute only.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { PgAuthorityStore } from "../src/d4/corpusAuthorityStore"
import { readCorpusReaderConfig, type CorpusReaderConfig } from "../src/d4/corpusReaderConfig"
import { type CorpusDb, createCorpusDb } from "./corpusPg"

const ACT = "Q03 Synthetic As-At Act"
const V1 = "Q03 synthetic s.7 as enacted (test text)"
const V2 = "Q03 synthetic s.7 as amended (test text)"
const PROVENANCE = {
  source_name: "q03-asat-fixture",
  source_url: "https://q03.example.invalid/asat",
  raw_storage_key: null,
  fetched_at: "2010-01-02T03:04:05Z",
  content_hash: "c3".repeat(32),
  extraction_method: "manual",
  extractor_version: "q03-asat-1",
}
const trusted = { level: "trusted", confidence: 0.95 }

let db: CorpusDb
const stores: PgAuthorityStore[] = []
const batchDirs: string[] = []

function writeBatch(doc: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q03-asat-"))
  batchDirs.push(dir)
  const file = path.join(dir, "batch.json")
  fs.writeFileSync(file, JSON.stringify(doc))
  return file
}

function history(versions: unknown[]) {
  return {
    kind: "statute_section_history",
    item_key: "q03-s7",
    trust: trusted,
    provenance: PROVENANCE,
    statute: {
      name: ACT,
      short_name: "Q03 As-At",
      year_enacted: 2010,
      jurisdiction: "Federal",
      status: null,
    },
    section: { section_number: "7", chapter: "I", current_title: "Q03 synthetic section 7" },
    history: "amendment_history",
    versions,
  }
}

function version(no: number, from: string, to: string | null, text: string) {
  return { version_no: no, effective_from: from, effective_to: to, title: null, text, version_confidence: 0.9 }
}

function batch(key: string, versions: unknown[]) {
  return writeBatch({
    format: "corpus-publication-batch/1",
    batch_key: key,
    source_kind: "curated",
    items: [history(versions)],
  })
}

function readerConfig(): CorpusReaderConfig {
  const r = readCorpusReaderConfig(
    { SIKANDER_CORPUS_READER_URL: db.readerUrl, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" },
    false,
  )
  if (!r.ok) throw new Error(`reader config: ${r.reason}`)
  return r.config
}

async function ids(): Promise<{ sectionId: string; versionId: string; versionNo: number }[]> {
  const result = await db.admin.query(
    "SELECT ss.id::text AS section_id, v.id::text AS version_id, v.version_no "
      + "FROM statute_section ss "
      + "JOIN statute s ON s.id = ss.statute_id "
      + "JOIN statute_section_version v ON v.section_id = ss.id "
      + "WHERE s.name = $1 ORDER BY v.version_no",
    [ACT],
  )
  return result.rows.map((row: { section_id: string; version_id: string; version_no: number }) => ({
    sectionId: row.section_id,
    versionId: row.version_id,
    versionNo: row.version_no,
  }))
}

beforeAll(async () => {
  db = await createCorpusDb("q03asat")
  // v1 open first. Closing it in the same publish that adds v2 keeps both row ids.
  await db.publish(batch("curated/q03-asat-open", [version(1, "2010-01-01", null, V1)]))
  const opened = await ids()
  expect(opened.map((row) => row.versionNo)).toEqual([1])
  await db.publish(batch(
    "curated/q03-asat-closed",
    [version(1, "2010-01-01", "2016-07-01", V1), version(2, "2016-07-01", null, V2)],
  ))
  const closed = await ids()
  expect(closed.map((row) => row.versionNo)).toEqual([1, 2])
  expect(closed[0].sectionId).toBe(opened[0].sectionId)
  expect(closed[0].versionId).toBe(opened[0].versionId)
}, 240_000)

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.end()))
})

afterAll(async () => {
  await db?.drop()
  for (const dir of batchDirs) fs.rmSync(dir, { recursive: true, force: true })
}, 120_000)

describe("Q03 statute as-at", () => {
  it("reads the enacted text on 2015-06-30 and the amended text today, including the boundaries", async () => {
    const store = new PgAuthorityStore(readerConfig())
    stores.push(store)
    const sectionId = (await ids())[0].sectionId
    const today = new Date().toISOString().slice(0, 10)
    expect(await store.getSectionAsAt(sectionId, "2015-06-30", "FEDERAL")).toEqual({ text: V1 })
    expect(await store.getSectionAsAt(sectionId, today, "FEDERAL")).toEqual({ text: V2 })
    expect(await store.getSectionAsAt(sectionId, "2016-07-01", "FEDERAL")).toEqual({ text: V2 })
    expect(await store.getSectionAsAt(sectionId, "2016-06-30", "FEDERAL")).toEqual({ text: V1 })
    expect(await store.getSectionAsAt(sectionId, "2009-12-31", "FEDERAL")).toBe("no_history")
  })
})
