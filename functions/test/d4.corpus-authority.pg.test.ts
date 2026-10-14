import { randomUUID } from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import pg from "pg"
import { logger } from "firebase-functions"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { normaliseCitation } from "@/services/d4-2/citations"
import { AuthorityUnavailableError } from "../src/d4/authority"
import {
  BREAKER_OPEN_MS,
  PgAuthorityStore,
  STATEMENT_TIMEOUT_MS,
  annexJurisdiction,
  classifyPgError,
  coveringVersion,
  versionUsable,
  type SectionVersionRow,
} from "../src/d4/corpusAuthorityStore"
import { runGate } from "../src/d4/gate"
import { readCorpusReaderConfig, type CorpusReaderConfig } from "../src/d4/corpusReaderConfig"
import { CORPUS_FIXTURES, type CorpusDb, type PublishSummary, createCorpusDb } from "./corpusPg"

/**
 * The F05 corpus adapter (plan Tasks 6 and 7) against real Postgres: one database for this file, Annex A 001 -> 003
 * -> 004, seeded through the publication CLI as a corpus_writer member, read as a corpus_reader login. Runs only in
 * `npm run test:f05-authority` (F05_AUTHORITY_SUITE=1, D14). Fixtures follow P4-13 (2099, "Test Act 2099").
 */

type GoldenCase = { id: string; raw: string; parts: Record<string, string | null> | null; python: string; canonical: string | null }
const GOLDEN: GoldenCase[] = JSON.parse(fs.readFileSync(path.join(CORPUS_FIXTURES, "citation-canonical-golden.json"), "utf8")).cases
const MATCHED = GOLDEN.filter((c) => c.python === "match" && c.parts && c.canonical)

const PROVENANCE = {
  source_name: "f05-adapter-fixture",
  source_url: "https://f05.example.invalid/adapter",
  raw_storage_key: null,
  fetched_at: "2099-01-02T03:04:05Z",
  content_hash: "ad".repeat(32),
  extraction_method: "manual",
  extractor_version: "f05-adapter-1",
}
const trusted = { level: "trusted", confidence: 0.95 }
const S5_V1 = "Section 5 as enacted: thirty days."
const S5_V2 = "Section 5 as amended: sixty days."

let db: CorpusDb
const stores: PgAuthorityStore[] = []
/** Judgment id by canonical citation (the golden judgments) and by item key (the treatment fixtures). */
const byCanonical = new Map<string, string>()
const byItem = new Map<string, string>()
let S5 = ""
let S6 = ""

function writeBatch(doc: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f05-adapter-"))
  const file = path.join(dir, "batch.json")
  fs.writeFileSync(file, JSON.stringify(doc))
  return file
}

const judgmentIds = (summary: PublishSummary) =>
  new Map(summary.items.filter((o) => o.entity_type === "judgment" && o.entity_id).map((o) => [o.item_key, o.entity_id as string]))

function readerConfig(overrides: Record<string, string | undefined> = {}): CorpusReaderConfig {
  const r = readCorpusReaderConfig({ SIKANDER_CORPUS_READER_URL: db.readerUrl, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24", ...overrides }, false)
  if (!r.ok) throw new Error(`reader config: ${r.reason}`)
  return r.config
}

function store(config: CorpusReaderConfig = readerConfig()): PgAuthorityStore {
  const s = new PgAuthorityStore(config)
  stores.push(s)
  return s
}

beforeAll(async () => {
  db = await createCorpusDb("adapter")
  // One division-bench judgment per distinct canonical key the Python builder produces from the golden parts.
  const seen = new Set<string>()
  const golden = MATCHED.filter((c) => !seen.has(c.canonical as string) && seen.add(c.canonical as string))
  const judgment = (key: string, citations: unknown[], bench: string) => ({
    kind: "judgment", item_key: key, trust: trusted, provenance: PROVENANCE, citations,
    case_title: `F05 adapter ${key} v. The State 2099`, bench_type: bench, full_text: `Synthetic F05 adapter fixture ${key}.`,
  })
  const treatment = (key: string, treating: string, treated: string, kind: string, confidence: number) => ({
    kind: "treatment", item_key: key, trust: trusted, provenance: PROVENANCE, treating: { item_key: treating }, treated: { item_key: treated },
    treatment: kind, passage_anchor: null, treating_bench_type: "larger", confidence,
  })
  const history = (key: string, section: string, kind: string, versions: unknown[]) => ({
    kind: "statute_section_history", item_key: key, trust: trusted, provenance: PROVENANCE,
    statute: { name: "Test Act 2099", short_name: "TA 2099", year_enacted: 2099, jurisdiction: "Federal", status: null },
    section: { section_number: section, chapter: "I", current_title: `Test section ${section}` }, history: kind, versions,
  })
  const version = (no: number, from: string, to: string | null, text: string, confidence: number) => ({
    version_no: no, effective_from: from, effective_to: to, title: null, text, version_confidence: confidence,
  })
  const summary = await db.publish(
    writeBatch({
      format: "corpus-publication-batch/1",
      batch_key: "curated/f05-adapter-2099",
      source_kind: "curated",
      items: [
        ...golden.map((c, i) => judgment(`g-${i}`, [{ parts: c.parts }], "division")),
        judgment("t-larger", [{ text: "2099 SCMR 9901" }], "Larger Bench"),
        judgment("t-full", [{ text: "2099 SCMR 9902" }], "FB"),
        judgment("t-overruled", [{ text: "2099 SCMR 9903" }], "DB"),
        judgment("t-followed", [{ text: "2099 SCMR 9904" }], "DB"),
        judgment("t-pending", [{ text: "2099 SCMR 9905" }], "DB"),
        treatment("tr-overruled", "t-larger", "t-overruled", "Overruled", 0.9),
        treatment("tr-followed", "t-full", "t-followed", "followed", 0.9),
        treatment("tr-pending", "t-larger", "t-pending", "overruled", 0.6),
        history("h-5", "5", "amendment_history", [version(1, "2099-01-01", "2099-07-01", S5_V1, 0.9), version(2, "2099-07-01", null, S5_V2, 0.9)]),
        history("h-6", "6", "current_text_only", [version(1, "2099-01-01", null, "Section 6 current text.", 0.5)]),
      ],
    })
  )
  const ids = judgmentIds(summary)
  golden.forEach((c, i) => byCanonical.set(c.canonical as string, ids.get(`g-${i}`) ?? ""))
  for (const [k, v] of ids) byItem.set(k, v)
  const section = async (n: string) =>
    (await db.admin.query("SELECT ss.id::text AS id FROM statute_section ss JOIN statute s ON s.id = ss.statute_id WHERE s.name = 'Test Act 2099' AND ss.section_number = $1", [n])).rows[0].id as string
  S5 = await section("5")
  S6 = await section("6")
}, 240_000)

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.end()))
})

afterAll(async () => {
  await db?.drop()
}, 120_000)

describe("F05 adapter helpers (pure)", () => {
  it("annexJurisdiction maps upper-case codes by equality only (D3, ruling 6)", () => {
    expect(["FEDERAL", "SINDH", "PUNJAB", "KP", "BALOCHISTAN", "ICT", "GB", "AJK"].map(annexJurisdiction)).toEqual([
      "Federal", "Sindh", "Punjab", "KP", "Balochistan", "ICT", "GB", "AJK",
    ])
    for (const code of ["PK", "SD", "KPK", "ISLAMABAD", "Federal", "federal", "Sindh", " FEDERAL", "FEDERAL ", ""]) {
      expect(annexJurisdiction(code), code).toBeNull()
    }
  })

  it("versionUsable is strictly above 0.5 and NaN-safe (D4, ruling 4)", () => {
    expect([0.5, 0.5000001, 1, 1.0000001, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null].map(versionUsable)).toEqual([
      false, true, true, false, false, false, false, false, false, false,
    ])
  })

  it("coveringVersion picks the one version with from <= date < to; each inconsistency throws inconsistent (D5)", () => {
    const v = (versionNo: number, effectiveFrom: string, effectiveTo: string | null, text = `v${versionNo}`): SectionVersionRow => ({
      versionNo, effectiveFrom, effectiveTo, text, versionConfidence: 0.9,
    })
    const rows = [v(1, "2099-01-01", "2099-07-01"), v(2, "2099-07-01", null)]
    expect(coveringVersion(rows, "2098-12-31")).toBeNull()
    expect(coveringVersion(rows, "2099-01-01")?.versionNo).toBe(1)
    expect(coveringVersion(rows, "2099-06-30")?.versionNo).toBe(1)
    expect(coveringVersion(rows, "2099-07-01")?.versionNo).toBe(2)
    expect(coveringVersion(rows, "2150-01-01")?.versionNo).toBe(2)
    expect(coveringVersion([v(1, "2099-01-01", "2099-03-01")], "2099-03-01")).toBeNull()
    expect(coveringVersion([], "2099-03-01")).toBeNull()
    for (const [name, bad] of [
      ["reversed range", [v(1, "2099-07-01", "2099-01-01")]],
      ["empty range", [v(1, "2099-07-01", "2099-07-01")]],
      ["overlap", [v(1, "2099-01-01", "2099-08-01"), v(2, "2099-07-01", null)]],
      ["open range not last", [v(1, "2099-01-01", null), v(2, "2099-07-01", null)]],
      ["version numbers out of order", [v(2, "2099-01-01", "2099-07-01"), v(1, "2099-07-01", null)]],
      ["not a date", [v(1, "2099-1-1", null)]],
    ] as const) {
      expect(() => coveringVersion(bad, "2099-07-15"), name).toThrow(AuthorityUnavailableError)
      try {
        coveringVersion(bad, "2099-07-15")
      } catch (e) {
        expect((e as AuthorityUnavailableError).reason, name).toBe("inconsistent")
      }
    }
  })
})

describe("PgAuthorityStore lookups (F05 plan Task 6)", () => {
  it("findJudgment matches the canonical key exactly, for every golden case the Python builder keys", async () => {
    const s = store()
    expect(MATCHED.length).toBeGreaterThan(40)
    for (const c of MATCHED) {
      const canonical = c.canonical as string
      expect(normaliseCitation(canonical), c.id).toBe(canonical)
      expect(await s.findJudgment(canonical), c.id).toEqual({ judgmentId: byCanonical.get(canonical), benchType: "division" })
      // The store matches the canonical key only: the draft's own spelling is the gate's job (Review Focus 4).
      if (c.raw !== canonical) expect(await s.findJudgment(c.raw), `${c.id} raw`).toBeNull()
      // A near miss is a miss.
      const nearMiss = canonical.replace(/(\d+)(\D*)$/, (_, page: string, rest: string) => `${Number(page) + 1}${rest}`)
      expect(nearMiss).not.toBe(canonical)
      if (!byCanonical.has(nearMiss)) expect(await s.findJudgment(nearMiss), `${c.id} near miss`).toBeNull()
    }
  })

  it("listTreatments returns lowercase kinds and the treating judgment's own bench", async () => {
    const s = store()
    expect(await s.listTreatments(byItem.get("t-overruled") as string)).toEqual([
      { kind: "overruled", treatingJudgmentBench: "larger", recordedTreatingBench: "larger" },
    ])
    expect(await s.listTreatments(byItem.get("t-followed") as string)).toEqual([
      { kind: "followed", treatingJudgmentBench: "full", recordedTreatingBench: "larger" },
    ])
    expect(await s.listTreatments(byItem.get("t-larger") as string)).toEqual([])
  })

  it("listTreatments throws pending_review for a quarantined overruling (ruling 3)", async () => {
    await expect(store().listTreatments(byItem.get("t-pending") as string)).rejects.toMatchObject({ name: "AuthorityUnavailableError", reason: "pending_review" })
  })

  it("listTreatments throws inconsistent for a judgment id that is not a UUID, and never returns [] on failure (D5)", async () => {
    const s = store()
    for (const id of ["j_101", "", "not-a-uuid", `${randomUUID()}x`]) {
      await expect(s.listTreatments(id), id).rejects.toMatchObject({ name: "AuthorityUnavailableError", reason: "inconsistent" })
    }
    await db.admin.query("ALTER VIEW public.v_authority_treatment RENAME TO v_authority_treatment_gone")
    try {
      await expect(store().listTreatments(byItem.get("t-overruled") as string)).rejects.toBeInstanceOf(AuthorityUnavailableError)
    } finally {
      await db.admin.query("ALTER VIEW public.v_authority_treatment_gone RENAME TO v_authority_treatment")
    }
  })

  it("getSectionAsAt: amendment boundaries, unmapped and PK codes, non-UUID ids and the 0.5 version give the expected text or no_history", async () => {
    const s = store()
    const at = (date: string, code = "FEDERAL", id = S5) => s.getSectionAsAt(id, date, code)
    expect(await at("2098-12-31")).toBe("no_history")
    expect(await at("2099-01-01")).toEqual({ text: S5_V1 })
    expect(await at("2099-06-30")).toEqual({ text: S5_V1 })
    expect(await at("2099-07-01")).toEqual({ text: S5_V2 })
    expect(await at("2150-01-01")).toEqual({ text: S5_V2 })
    for (const code of ["PK", "SINDH", "Federal", "federal", "FED"]) expect(await at("2099-08-01", code), code).toBe("no_history")
    for (const id of ["test_act_s5", S5.toUpperCase().replace(/-/g, ""), ""]) expect(await at("2099-08-01", "FEDERAL", id), id).toBe("no_history")
    for (const date of ["2099-8-1", "01/08/2099", "2099-08-01T00:00:00Z"]) expect(await at(date), date).toBe("no_history")
    expect(await at("2099-08-01", "FEDERAL", S6)).toBe("no_history")
    expect(await at("2099-08-01", "FEDERAL", randomUUID())).toBe("no_history")
  })

  it("dates do not move with the process time zone (Review Focus 2)", async () => {
    const saved = process.env.TZ
    const raw = new pg.Client({ connectionString: db.urlAs() })
    await raw.connect()
    try {
      const shifts: string[] = []
      for (const tz of ["UTC", "Asia/Karachi", "America/Los_Angeles"]) {
        process.env.TZ = tz
        // Control: node-pg's own DATE parser does move with the zone, so the zone change is live.
        shifts.push(((await raw.query("SELECT '2099-07-01'::date AS d")).rows[0].d as Date).toISOString())
        const s = store()
        expect(await s.getSectionAsAt(S5, "2099-07-01", "FEDERAL"), tz).toEqual({ text: S5_V2 })
        expect(await s.getSectionAsAt(S5, "2099-06-30", "FEDERAL"), tz).toEqual({ text: S5_V1 })
      }
      expect(new Set(shifts).size).toBe(3)
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
      await raw.end()
    }
  })
})

describe("PgAuthorityStore failure handling (F05 plan Task 7)", () => {
  const ANY = "2099 SCMR 9903"
  const unavailableAs = (reason: string) => ({ name: "AuthorityUnavailableError", reason })

  type Sql = string | [string, unknown[]]
  const exec = (sql: Sql) => (typeof sql === "string" ? db.admin.query(sql) : db.admin.query(sql[0], sql[1]))
  /** Superuser SQL now, and its undo after `fn`, whatever happens. */
  async function withState<T>(apply: Sql, undo: Sql, fn: () => Promise<T>): Promise<T> {
    await exec(apply)
    try {
      return await fn()
    } finally {
      await exec(undo)
    }
  }

  const metadata = async (key: string) => (await db.admin.query("SELECT value FROM corpus_metadata WHERE key = $1", [key])).rows[0]?.value as string
  const d30 = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z")

  /** A port on 127.0.0.1 that was bound and closed again: nothing listens there. */
  async function closedPort(): Promise<number> {
    const server = net.createServer()
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()))
    const port = (server.address() as net.AddressInfo).port
    await new Promise<void>((ok) => server.close(() => ok()))
    return port
  }

  /** A server that accepts TCP and never answers; counts the connections it saw. */
  async function hungServer(): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
    let seen = 0
    const sockets: net.Socket[] = []
    const server = net.createServer((socket) => {
      seen += 1
      sockets.push(socket)
      socket.on("error", () => undefined)
    })
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()))
    return {
      port: (server.address() as net.AddressInfo).port,
      connections: () => seen,
      close: () =>
        new Promise<void>((ok) => {
          for (const s of sockets) s.destroy()
          server.close(() => ok())
        }),
    }
  }

  it("contract_missing: no publication contract, or a last_refresh that is missing or not D30's format (D19)", async () => {
    const contract = await metadata("publication_contract")
    await withState("DELETE FROM corpus_metadata WHERE key = 'publication_contract'", ["INSERT INTO corpus_metadata (key, value) VALUES ('publication_contract', $1)", [contract]], async () => {
      await expect(store().findJudgment(ANY)).rejects.toMatchObject(unavailableAs("contract_missing"))
    })
    await withState("UPDATE corpus_metadata SET value = '2' WHERE key = 'publication_contract'", "UPDATE corpus_metadata SET value = '1' WHERE key = 'publication_contract'", async () => {
      await expect(store().findJudgment(ANY)).rejects.toMatchObject(unavailableAs("contract_missing"))
    })
    const refresh = await metadata("last_refresh")
    const setRefresh = (value: string): Sql => ["UPDATE corpus_metadata SET value = $1 WHERE key = 'last_refresh'", [value]]
    for (const garbage of ["yesterday", "2099-01-01", "2099-01-01T00:00:00Z", "2099-13-01T00:00:00.000000Z", "2099-02-30T00:00:00.000000Z"]) {
      await withState(setRefresh(garbage), setRefresh(refresh), async () => {
        await expect(store().findJudgment(ANY), garbage).rejects.toMatchObject(unavailableAs("contract_missing"))
      })
    }
    await withState("DELETE FROM corpus_metadata WHERE key = 'last_refresh'", ["INSERT INTO corpus_metadata (key, value) VALUES ('last_refresh', $1)", [refresh]], async () => {
      await expect(store().findJudgment(ANY)).rejects.toMatchObject(unavailableAs("contract_missing"))
    })
    expect(await store().findJudgment(ANY)).toMatchObject({ benchType: "division" })
  })

  it("stale: a last_refresh older than SIKANDER_CORPUS_MAX_STALENESS_HOURS, or more than five minutes in the future (ruling 5, D19)", async () => {
    const refresh = await metadata("last_refresh")
    const setRefresh = (value: string): Sql => ["UPDATE corpus_metadata SET value = $1 WHERE key = 'last_refresh'", [value]]
    for (const [label, value] of [
      ["old", "2000-01-01T00:00:00.000000Z"],
      ["25 hours ago", d30(Date.now() - 25 * 3600_000)],
      ["10 minutes ahead", d30(Date.now() + 10 * 60_000)],
    ] as const) {
      await withState(setRefresh(value), setRefresh(refresh), async () => {
        await expect(store().findJudgment(ANY), label).rejects.toMatchObject(unavailableAs("stale"))
      })
    }
    // Inside the bound it reads: 23 hours ago against 24, and 2 minutes ahead (clock skew).
    for (const value of [d30(Date.now() - 23 * 3600_000), d30(Date.now() + 2 * 60_000)]) {
      await withState(setRefresh(value), setRefresh(refresh), async () => {
        expect(await store().findJudgment(ANY), value).toMatchObject({ benchType: "division" })
      })
    }
    // The bound is the configured one: 1 hour refuses what 24 accepted.
    await withState(setRefresh(d30(Date.now() - 2 * 3600_000)), setRefresh(refresh), async () => {
      await expect(store(readerConfig({ SIKANDER_CORPUS_MAX_STALENESS_HOURS: "1" })).findJudgment(ANY)).rejects.toMatchObject(unavailableAs("stale"))
    })
  })

  it("wrong_role: the writer's login, a superuser, or a session that is not read-only (D7, ruling 13)", async () => {
    const writer = readCorpusReaderConfig({ SIKANDER_CORPUS_READER_URL: db.writerUrl, SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" }, false)
    const superuser = readCorpusReaderConfig({ SIKANDER_CORPUS_READER_URL: db.urlAs(), SIKANDER_CORPUS_MAX_STALENESS_HOURS: "24" }, false)
    if (!writer.ok || !superuser.ok) throw new Error("config")
    await expect(store(writer.config).findJudgment(ANY)).rejects.toMatchObject(unavailableAs("wrong_role"))
    await expect(store(superuser.config).findJudgment(ANY)).rejects.toMatchObject(unavailableAs("wrong_role"))
    const readWrite = new PgAuthorityStore(readerConfig(), { sessionOptions: "-c default_transaction_read_only=off" })
    stores.push(readWrite)
    await expect(readWrite.findJudgment(ANY)).rejects.toMatchObject(unavailableAs("wrong_role"))
    // A reader that is also a corpus_writer member is refused too.
    await withState(`GRANT corpus_writer TO "${db.readerUser}" WITH INHERIT FALSE, SET TRUE`, `REVOKE corpus_writer FROM "${db.readerUser}"`, async () => {
      await expect(store().findJudgment(ANY)).rejects.toMatchObject(unavailableAs("wrong_role"))
    })
  })

  it("permission and schema_missing: a revoked grant, a renamed view", async () => {
    await withState("REVOKE SELECT ON public.v_authority_citation FROM corpus_reader", "GRANT SELECT ON public.v_authority_citation TO corpus_reader", async () => {
      await expect(store().findJudgment(ANY)).rejects.toMatchObject(unavailableAs("permission"))
    })
    await withState("ALTER VIEW public.v_authority_citation RENAME TO v_authority_citation_gone", "ALTER VIEW public.v_authority_citation_gone RENAME TO v_authority_citation", async () => {
      await expect(store().findJudgment(ANY)).rejects.toMatchObject(unavailableAs("schema_missing"))
    })
  })

  it("unreachable and auth: a closed port, a login the server refuses", async () => {
    const closed = new URL(db.readerUrl)
    closed.port = String(await closedPort())
    await expect(store(readerConfig({ SIKANDER_CORPUS_READER_URL: closed.toString() })).findJudgment(ANY)).rejects.toMatchObject(unavailableAs("unreachable"))
    // A role that does not exist, and one that may not log in (28000). The server's password check itself (28P01)
    // depends on its pg_hba (the local test server trusts loopback), so classifyPgError's table covers that code.
    const nologin = `f05_nologin_${randomUUID().slice(0, 8)}`
    await withState(`CREATE ROLE "${nologin}" NOLOGIN IN ROLE corpus_reader`, `DROP ROLE "${nologin}"`, async () => {
      for (const user of [nologin, `f05_absent_${randomUUID().slice(0, 8)}`]) {
        const refused = new URL(db.readerUrl)
        refused.username = user
        await expect(store(readerConfig({ SIKANDER_CORPUS_READER_URL: refused.toString() })).findJudgment(ANY), user).rejects.toMatchObject(unavailableAs("auth"))
      }
    })
  })

  it("timeout: a lock held by another session; the call settles within STATEMENT_TIMEOUT_MS + 2000", async () => {
    const locker = new pg.Client({ connectionString: db.urlAs() })
    await locker.connect()
    try {
      const s = store()
      await s.getSectionAsAt(S5, "2099-08-01", "FEDERAL") // warm: the state check is cached, only the lookup blocks
      await locker.query("BEGIN")
      await locker.query("LOCK TABLE public.citation IN ACCESS EXCLUSIVE MODE")
      const started = Date.now()
      await expect(s.findJudgment(ANY)).rejects.toMatchObject(unavailableAs("timeout"))
      expect(Date.now() - started).toBeLessThan(STATEMENT_TIMEOUT_MS + 2000)
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined)
      await locker.end()
    }
  }, 30_000)

  it("a hung server costs one connect timeout: 25 citations gate in under 10 s, every one UNVERIFIED (Review Focus 3)", async () => {
    const hung = await hungServer()
    try {
      const url = new URL(db.readerUrl)
      url.port = String(hung.port)
      const s = store(readerConfig({ SIKANDER_CORPUS_READER_URL: url.toString() }))
      const body = Array.from({ length: 25 }, (_, i) => `2099 SCMR ${8100 + i}`).join(", ")
      const started = Date.now()
      const out = await runGate({ title: "Petition", body: `The petitioner relies on ${body}.`, temporalChecks: [] }, s)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(out.citations).toHaveLength(25)
      expect(out.citations.every((c) => c.status === "UNVERIFIED" && c.judgmentId === null)).toBe(true)
      expect(out.status).toBe("UNVERIFIED")
      expect(hung.connections()).toBe(1)
    } finally {
      await hung.close()
    }
  }, 30_000)

  it("circuit_open: within the window a second call does not connect; after it the store tries again", async () => {
    const hung = await hungServer()
    let now = 1_000_000
    try {
      const url = new URL(db.readerUrl)
      url.port = String(hung.port)
      const s = new PgAuthorityStore(readerConfig({ SIKANDER_CORPUS_READER_URL: url.toString() }), { now: () => now })
      stores.push(s)
      await expect(s.findJudgment(ANY)).rejects.toMatchObject(unavailableAs("timeout"))
      expect(hung.connections()).toBe(1)
      now += BREAKER_OPEN_MS - 1
      await expect(s.findJudgment(ANY)).rejects.toMatchObject(unavailableAs("circuit_open"))
      await expect(s.listTreatments(byItem.get("t-overruled") as string)).rejects.toMatchObject(unavailableAs("circuit_open"))
      await expect(s.getSectionAsAt(S5, "2099-08-01", "FEDERAL")).rejects.toMatchObject(unavailableAs("circuit_open"))
      expect(hung.connections()).toBe(1)
      now += 1
      await expect(s.findJudgment(ANY)).rejects.toMatchObject(unavailableAs("timeout"))
      expect(hung.connections()).toBe(2)
    } finally {
      await hung.close()
    }
  }, 30_000)

  it("pending_review and inconsistent do not open the breaker: the next call still reads", async () => {
    const s = store()
    await expect(s.listTreatments(byItem.get("t-pending") as string)).rejects.toMatchObject(unavailableAs("pending_review"))
    await expect(s.listTreatments("j_101")).rejects.toMatchObject(unavailableAs("inconsistent"))
    expect(await s.findJudgment(ANY)).toMatchObject({ benchType: "division" })
  })

  it("classifyPgError covers SQLSTATEs, Node error codes, timeouts and TLS failures (D6)", () => {
    const err = (props: Record<string, unknown>, message = "x") => Object.assign(new Error(message), props)
    const table: Array<[unknown, string]> = [
      [err({ code: "42501" }), "permission"],
      [err({ code: "28P01" }), "auth"],
      [err({ code: "28000" }), "auth"],
      [err({ code: "57014" }), "timeout"],
      [err({ code: "42P01" }), "schema_missing"],
      [err({ code: "42703" }), "schema_missing"],
      [err({ code: "3D000" }), "schema_missing"],
      [err({ code: "08006" }), "unreachable"],
      [err({ code: "08001" }), "unreachable"],
      [err({ code: "57P01" }), "unreachable"],
      [err({ code: "ECONNREFUSED" }), "unreachable"],
      [err({ code: "ENOTFOUND" }), "unreachable"],
      [err({ code: "EHOSTUNREACH" }), "unreachable"],
      [err({ code: "ECONNRESET" }), "unreachable"],
      [err({ code: "ETIMEDOUT" }), "timeout"],
      [err({}, "timeout exceeded when trying to connect"), "timeout"],
      [err({}, "Connection terminated due to connection timeout"), "timeout"],
      [err({}, "timeout expired"), "timeout"],
      [err({}, "Query read timeout"), "timeout"],
      [err({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "tls"],
      [err({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), "tls"],
      [err({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "tls"],
      [err({ code: "CERT_HAS_EXPIRED" }), "tls"],
      [err({ code: "SELF_SIGNED_CERT_IN_CHAIN" }), "tls"],
      [err({}, "The server does not support SSL connections"), "tls"],
      [err({ code: "22P02" }), "error"],
      [err({}, "something else"), "error"],
      ["not an error", "error"],
      [null, "error"],
      [new AuthorityUnavailableError("stale"), "stale"],
    ]
    for (const [e, reason] of table) expect(classifyPgError(e), JSON.stringify((e as { code?: unknown })?.code ?? String(e))).toBe(reason)
  })

  it("the unavailable log carries the reason only, once per opening of the breaker", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined)
    try {
      const closed = new URL(db.readerUrl)
      closed.port = String(await closedPort())
      const s = store(readerConfig({ SIKANDER_CORPUS_READER_URL: closed.toString() }))
      await expect(s.findJudgment(ANY)).rejects.toMatchObject(unavailableAs("unreachable"))
      await expect(s.findJudgment(ANY)).rejects.toMatchObject(unavailableAs("circuit_open"))
      const calls = warn.mock.calls.filter((c) => c[0] === "d4.authority_unavailable")
      expect(calls).toEqual([["d4.authority_unavailable", { reason: "unreachable" }]])
      const logged = JSON.stringify(warn.mock.calls)
      for (const secret of [db.readerPassword, db.readerUser, closed.port, "ECONNREFUSED", "127.0.0.1"]) expect(logged).not.toContain(secret)
    } finally {
      warn.mockRestore()
    }
  })
})
