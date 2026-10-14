import { createServer } from "node:net"
import path from "node:path"
import pg from "pg"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { setAuthorityStoreForTests } from "../src/d4/authority"
import { ApiError, apiErrorOf, viaApi } from "./api"
import { CORPUS_FIXTURES, type CorpusDb, type PublishSummary, createCorpusDb, resetAuthorityStore, withCorpusReaderEnv } from "./corpusPg"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Audit finding F05 (2026-10-13): "partners must override without an integrated authority lookup". End to end,
 * through the HTTP router, with real ID tokens from the Auth emulator, every write read back from the Firestore
 * emulator, and the authority answered by the firm's promoted Annex A corpus on real Postgres. The corpus is
 * seeded the way an operator seeds it: PR 2's publication CLI, as a corpus_writer member.
 *
 * The user flow: a member drafts a document that cites reported judgments and pleads a statute section, gates it
 * (gateDraft), and the matter partner approves it (approveDraft re-runs the gate and is 409 gate_blocked unless the
 * fresh run passes). Before the fix the gate ran on EMPTY_AUTHORITY_STORE whatever the deployment held: every
 * citation UNVERIFIED and every temporal check TEMPORAL_UNAVAILABLE, so a partner could only override. After it, a
 * configured reader answers from the promoted, published, provenance-complete, public corpus (004's v_authority_*
 * views); anything it cannot prove stays UNVERIFIED / TEMPORAL_UNAVAILABLE, and any doubt about the corpus itself
 * (unreachable, slow, wrong role, stale, no contract, a missing view or grant, an unset environment) fails closed.
 *
 * Fixtures follow P4-13: the year 2099, "Test Act 2099", and no real judgment, statute or party.
 */

if (!EMULATORS) {
  throw new Error("the F05 user-flow e2e needs the Auth and Firestore emulators: run it with `npm run test:f05-authority`")
}

type GateScope = { citations: number; temporalChecks: number; assessed: boolean }
type CitationFinding = { ref: string; judgmentId: string | null; status: string }
type TemporalFinding = { sectionId: string; asAtDate: string; jurisdiction: string; usedText: string; status: string; inForceText: string | null }
type GateResult = { draftId: string; version: number; status: string; scope: GateScope; resultId: string; citations: CitationFinding[]; temporal: TemporalFinding[] }
type DraftView = { draftId: string; status: string; locked: boolean; approvedBy?: string; gateResult: null | { status: string; overridden: boolean } }
type ChecklistEntry = { item: string; evidence: string }
type Approved = { draft: DraftView; gateResult: GateResult }
type Report = { gateResult: GateResult | null }
type TypeProfile = { id: string; checklist: string[] }
type Check = { sectionId: string; asAtDate: string; jurisdiction: string; usedText: string }

const createApi = viaApi<DraftView>("createDraft")
const gateApi = viaApi<GateResult>("gateDraft")
const reportApi = viaApi<Report>("getVerificationReport")
const approveApi = viaApi<Approved>("approveDraft")
const profileApi = viaApi<TypeProfile>("getTypeProfile")

/** A forum-filed type: law-dependent, so every approval also carries the type's full review checklist. */
const FORUM_TYPE = "constitutional_petition_199"
const V1 = "Section 5 as enacted: thirty days."
const V2 = "Section 5 as amended: sixty days."
const S6_TEXT = "Section 6 current text."
const MAIN_BATCH = path.join(CORPUS_FIXTURES, "curated-batch.f05.json")
const LATE_BATCH = path.join(CORPUS_FIXTURES, "curated-batch.f05-late.json")
const PENDING_BATCH = path.join(CORPUS_FIXTURES, "curated-batch.f05-pending.json")
const SLOW = 60_000

type Member = { uid: string; token: string }
type Firm = { firmId: string; matterId: string; P: Member; A: Member }

async function newFirm(): Promise<Firm> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", rateLimits: { general: 1000 } })
  const matterId = uniq("matter")
  await adminDb()
    .collection("matters")
    .doc(matterId)
    .set({ firmId, classification: "internal", title: "Petition against the order", stage: "pre_filing", status: "open" })
  const member = async (role: string): Promise<Member> => {
    const m = await mintIdToken({ firmId, role, clearanceLevel: "privileged-restricted" })
    await adminDb().collection("matter_members").doc(`${matterId}_${m.uid}`).set({ firmId, matterId, userId: m.uid, classification: "internal" })
    return m
  }
  return { firmId, matterId, P: await member("partner"), A: await member("associate") }
}

const send = <T>(api: (c: never) => Promise<T>, f: Firm, m: Member, data: Record<string, unknown>): Promise<T> =>
  api({ token: m.token, data: { firmId: f.firmId, ...data } } as never)
const create = (f: Firm, body: string) => send(createApi, f, f.A, { matterId: f.matterId, documentTypeId: FORUM_TYPE, title: "Draft for review", body })
const gate = (f: Firm, draftId: string, temporalChecks?: Check[]) =>
  send(gateApi, f, f.A, { draftId, version: 1, ...(temporalChecks === undefined ? {} : { temporalChecks }) })
const report = (f: Firm, draftId: string) => send(reportApi, f, f.P, { draftId })
const draftDoc = async (id: string) => (await adminDb().collection("drafts").doc(id).get()).data()
const overrideDoc = async (id: string) => (await adminDb().collection("draft_gate_overrides").doc(`${id}_1`).get()).data()

/** The partner's approval with the type's complete review checklist, so only the gate decides. */
async function approve(f: Firm, draftId: string): Promise<Approved> {
  const profile = await send(profileApi, f, f.P, { typeId: FORUM_TYPE })
  const reviewChecklist: ChecklistEntry[] = [...new Set(profile.checklist)].map((item, i) => ({
    item,
    evidence: `Reviewed against the file, point ${i + 1}: confirmed by the partner on the record.`,
  }))
  const resultId = (await report(f, draftId)).gateResult?.resultId ?? "no-result"
  return send(approveApi, f, f.P, { draftId, version: 1, resultId, reviewChecklist })
}

function expectErr(err: ApiError, status: number, code: string): void {
  expect({ status: err.status, code: err.code }).toEqual({ status, code })
}

const cites = (...refs: string[]) => `The petitioner relies on ${refs.join(" and on ")} for the rule that time runs from knowledge of the order.`
const pleads = (text: string) => `Under the Test Act 2099 the period stood as follows: ${text}`

let db: CorpusDb
let restoreEnv: () => void = () => undefined
let published: PublishSummary
/** Judgment ids by item key, and the section ids of "Test Act 2099" sections 5 and 6. */
const J: Record<string, string> = {}
let S5 = ""
let S6 = ""

/** The judgment, treatment or statute_section outcome of an item, as the CLI reported it. */
function primary(summary: PublishSummary, itemKey: string) {
  const mine = summary.items.filter((o) => o.item_key === itemKey)
  return mine.find((o) => ["judgment", "treatment", "statute_section"].includes(o.entity_type)) ?? mine[0]
}

async function sectionId(number: string): Promise<string> {
  const r = await db.admin.query(
    "SELECT ss.id::text AS id FROM statute_section ss JOIN statute s ON s.id = ss.statute_id WHERE s.name = 'Test Act 2099' AND ss.section_number = $1",
    [number]
  )
  return r.rows[0]?.id ?? ""
}

beforeAll(async () => {
  db = await createCorpusDb("e2e")
  published = await db.publish(MAIN_BATCH)
  for (const o of published.items) if (o.entity_type === "judgment" && o.entity_id) J[o.item_key] = o.entity_id
  S5 = await sectionId("5")
  S6 = await sectionId("6")
  // Ruling 2: a row a superuser writes straight into the tables (promoted, public, a bench, complete provenance) but
  // that no publication wrote. The reader must never see it.
  await db.admin.query(`
    WITH p AS (
      INSERT INTO source_provenance (source_name, source_url, fetched_at, content_hash, extraction_method, extractor_version)
      VALUES ('f05-superuser-seed', 'https://f05.example.invalid/superuser', '2099-01-01T00:00:00Z', repeat('e', 64), 'manual', 'f05-fixture-1')
      RETURNING id),
    j AS (
      INSERT INTO judgment (case_title, bench_type, classification, source_id, review_status)
      SELECT 'F05 superuser-seeded v. The State 2099', 'division', 'public', id, 'promoted' FROM p RETURNING id, source_id)
    INSERT INTO citation (judgment_id, citation_text, source_id, review_status)
    SELECT id, '2099 SCMR 919', source_id, 'promoted' FROM j`)
  restoreEnv = withCorpusReaderEnv(db)
}, 240_000)

afterAll(async () => {
  restoreEnv()
  await resetAuthorityStore()
  await db?.drop()
}, 120_000)

beforeEach(async () => {
  // The production selection path: no test store, so the gate runs on what the environment configures.
  setAuthorityStoreForTests(null)
  await resetAuthorityStore()
})
afterEach(() => {
  setAuthorityStoreForTests(null)
})

describe("F05: the draft gate answers from the promoted Annex A corpus (end to end through the HTTP routes)", () => {
  it("the fixture publishes as the corpus expects (precondition)", () => {
    const decided = Object.fromEntries(
      ["j-verified", "j-overruled", "j-larger", "j-cap", "j-pending", "j-review", "j-noprov", "j-restricted", "j-verified-2",
        "t-overruled", "t-cap", "t-pending", "t-restricted", "h-amended", "h-current"].map((k) => [k, [primary(published, k)?.decision, primary(published, k)?.reason ?? null]])
    )
    expect(decided).toEqual({
      "j-verified": ["promoted", null], "j-overruled": ["promoted", null], "j-larger": ["promoted", null], "j-cap": ["promoted", null],
      "j-pending": ["promoted", null], "j-review": ["quarantined", "review_source"], "j-noprov": ["rejected", "provenance_incomplete"],
      "j-restricted": ["promoted", null], "j-verified-2": ["promoted", null],
      "t-overruled": ["promoted", null], "t-cap": ["promoted", null], "t-pending": ["quarantined", "treatment_uncertain"],
      "t-restricted": ["promoted", null], "h-amended": ["promoted", null], "h-current": ["promoted", null],
    })
    expect(S5).toMatch(/^[0-9a-f-]{36}$/)
    expect(S6).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("F05-a verified citations and a pleaded temporal check give OK, and the partner approves with no override", async () => {
    const f = await newFirm()
    // PLD 2099 Kar. 12 is the golden's spelling of the same judgment's "PLD 2099 Sindh 12" (Review Focus 4).
    const d = await create(f, `${cites("2099 SCMR 101", "PLD 2099 Kar. 12")}\n${pleads(V2)}`)
    const check = { sectionId: S5, asAtDate: "2099-08-01", jurisdiction: "FEDERAL", usedText: V2 }
    const g = await gate(f, d.draftId, [check])
    expect(g.citations).toEqual([{ ref: "2099 SCMR 101", judgmentId: J["j-verified"], status: "VERIFIED" }])
    expect(g.temporal).toEqual([{ ...check, status: "OK", inForceText: V2 }])
    expect(g.scope).toEqual({ citations: 1, temporalChecks: 1, assessed: true })
    expect(g.status).toBe("OK")

    const a = await approve(f, d.draftId)
    expect(a.draft).toMatchObject({ status: "approved", locked: true, approvedBy: f.P.uid })
    expect(a.draft.gateResult).toMatchObject({ status: "OK", overridden: false })
    expect(await overrideDoc(d.draftId)).toBeUndefined()
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "approved", locked: true })
  }, SLOW)

  it("F05-b a division bench overruled by a larger bench gives OVERRULED, and approval is 409 gate_blocked", async () => {
    const f = await newFirm()
    // 2099 SCMR 110 is overruled by 2099 SCMR 808, a larger bench (until case d makes 808 confidential).
    const d = await create(f, cites("2099 SCMR 202", "2099 SCMR 110"))
    const g = await gate(f, d.draftId)
    expect(g.citations).toEqual([
      { ref: "2099 SCMR 202", judgmentId: J["j-overruled"], status: "OVERRULED" },
      { ref: "2099 SCMR 110", judgmentId: J["j-verified-2"], status: "OVERRULED" },
    ])
    expect(g.status).toBe("OVERRULED")
    expectErr(await apiErrorOf(approve(f, d.draftId)), 409, "gate_blocked")
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
  }, SLOW)

  it("F05-h a quarantined second overruling never hides a promoted larger-bench one: still OVERRULED, approval 409 (P4-2, #51 R1 D-1)", async () => {
    const f = await newFirm()
    const d = await create(f, cites("2099 SCMR 202"))
    expect((await gate(f, d.draftId)).citations).toEqual([{ ref: "2099 SCMR 202", judgmentId: J["j-overruled"], status: "OVERRULED" }])
    // A division-bench overruling of the same judgment, held at 0.6 (treatment_uncertain): pending review.
    const pending = await db.publish(PENDING_BATCH)
    expect(primary(pending, "t-pending-202")).toMatchObject({ decision: "quarantined", reason: "treatment_uncertain" })
    await resetAuthorityStore()
    const d2 = await create(f, cites("2099 SCMR 202"))
    const g = await gate(f, d2.draftId)
    expect(g.citations).toEqual([{ ref: "2099 SCMR 202", judgmentId: J["j-overruled"], status: "OVERRULED" }])
    expect(g.status).toBe("OVERRULED")
    expectErr(await apiErrorOf(approve(f, d2.draftId)), 409, "gate_blocked")
  }, SLOW)

  it("F05-c a later text pleaded for an earlier date gives TEMPORAL_MISMATCH with the text in force then", async () => {
    const f = await newFirm()
    const d = await create(f, pleads(V2))
    const check = { sectionId: S5, asAtDate: "2099-03-01", jurisdiction: "FEDERAL", usedText: V2 }
    const g = await gate(f, d.draftId, [check])
    expect(g.temporal).toEqual([{ ...check, status: "TEMPORAL_MISMATCH", inForceText: V1 }])
    expect(g.status).toBe("TEMPORAL_MISMATCH")
    expectErr(await apiErrorOf(approve(f, d.draftId)), 409, "gate_blocked")
  }, SLOW)

  const unproven: Array<{ name: string; body: () => string; check?: () => Check; setup?: () => Promise<void>; citation?: string; temporal?: string }> = [
    { name: "jurisdiction SINDH on a Federal section", body: () => pleads(V2), check: () => ({ sectionId: S5, asAtDate: "2099-08-01", jurisdiction: "SINDH", usedText: V2 }), temporal: "TEMPORAL_UNAVAILABLE" },
    { name: "jurisdiction PK (ruling 6: not mapped)", body: () => pleads(V2), check: () => ({ sectionId: S5, asAtDate: "2099-08-01", jurisdiction: "PK", usedText: V2 }), temporal: "TEMPORAL_UNAVAILABLE" },
    { name: "section 6, a 0.5-confidence current text only (ruling 4)", body: () => pleads(S6_TEXT), check: () => ({ sectionId: S6, asAtDate: "2099-08-01", jurisdiction: "FEDERAL", usedText: S6_TEXT }), temporal: "TEMPORAL_UNAVAILABLE" },
    { name: "2099 SCMR 606, quarantined (a review source)", body: () => cites("2099 SCMR 606"), citation: "UNVERIFIED" },
    { name: "2099 SCMR 707, rejected (incomplete provenance)", body: () => cites("2099 SCMR 707"), citation: "UNVERIFIED" },
    { name: "2099 SCMR 919, promoted by a superuser outside any publication (ruling 2)", body: () => cites("2099 SCMR 919"), citation: "UNVERIFIED" },
    { name: "2099 SCMR 505, under a quarantined overruling (ruling 3)", body: () => cites("2099 SCMR 505"), citation: "UNVERIFIED" },
    {
      name: "2099 SCMR 808, made confidential after publication (ruling 8)",
      body: () => cites("2099 SCMR 808"),
      setup: () => raiseRestricted(),
      citation: "UNVERIFIED",
    },
    {
      name: "2099 SCMR 110, whose overruling judgment is now confidential (D2: hidden is pending, never VERIFIED)",
      body: () => cites("2099 SCMR 110"),
      setup: () => raiseRestricted(),
      citation: "UNVERIFIED",
    },
    { name: "2099 SCMR 999, a fabricated citation", body: () => cites("2099 SCMR 999"), citation: "UNVERIFIED" },
  ]

  async function raiseRestricted(): Promise<void> {
    // A superuser raise (001 allows raises only): the judgment is no longer public.
    await db.admin.query("UPDATE judgment SET classification = 'confidential' WHERE id = $1", [J["j-restricted"]])
  }

  it.each(unproven)("F05-d each unproven authority stays UNVERIFIED or TEMPORAL_UNAVAILABLE: $name", async (c) => {
    await c.setup?.()
    const f = await newFirm()
    const d = await create(f, c.body())
    const g = await gate(f, d.draftId, c.check ? [c.check()] : undefined)
    if (c.citation) expect(g.citations.map((x) => x.status)).toEqual([c.citation])
    else expect(g.citations).toEqual([])
    if (c.temporal) expect(g.temporal.map((t) => [t.status, t.inForceText])).toEqual([[c.temporal, null]])
    else expect(g.temporal).toEqual([])
    expect(g.status).not.toBe("OK")
    expect(g.status).toBe(c.citation ?? c.temporal)
    expectErr(await apiErrorOf(approve(f, d.draftId)), 409, "gate_blocked")
  }, SLOW)

  it("F05-e a capitalised \"Overruled\" in the batch still yields OVERRULED", async () => {
    const f = await newFirm()
    const d = await create(f, cites("2099 SCMR 404"))
    const g = await gate(f, d.draftId)
    expect(g.citations).toEqual([{ ref: "2099 SCMR 404", judgmentId: J["j-cap"], status: "OVERRULED" }])
    expect(g.status).toBe("OVERRULED")
  }, SLOW)

  it("F05-g a draft with no citation and no check is NOT_ASSESSED", async () => {
    const f = await newFirm()
    const d = await create(f, "The petitioner prays that the order be set aside.")
    const g = await gate(f, d.draftId)
    expect(g.status).toBe("NOT_ASSESSED")
    expect(g.scope).toEqual({ citations: 0, temporalChecks: 0, assessed: false })
  }, SLOW)

  type Unavailable = { name: string; arrange: () => Promise<() => Promise<void>>; budgetMs?: number }

  /** A port on 127.0.0.1 that was bound and closed again: nothing listens there. */
  async function closedPort(): Promise<number> {
    const server = createServer()
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((ok) => server.close(() => ok()))
    return port
  }

  const setEnv = (name: string, value: string | undefined): (() => Promise<void>) => {
    const saved = process.env[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    return async () => {
      if (saved === undefined) delete process.env[name]
      else process.env[name] = saved
    }
  }

  /** Superuser SQL on the corpus database, run only when `relation` exists (it does not on the base, before 004). */
  const ifExists = async (relation: string, sql: string) => {
    await db.admin.query(`DO $$ BEGIN IF pg_catalog.to_regclass('${relation}') IS NOT NULL THEN ${sql}; END IF; END $$`)
  }

  const unavailable: Unavailable[] = [
    {
      name: "u1 a closed port",
      arrange: async () => {
        const url = new URL(db.readerUrl)
        url.port = String(await closedPort())
        return setEnv("SIKANDER_CORPUS_READER_URL", url.toString())
      },
    },
    {
      name: "u2 a lock that runs the reader into its statement timeout",
      budgetMs: 20_000,
      arrange: async () => {
        const locker = new pg.Client({ connectionString: db.urlAs() })
        await locker.connect()
        await locker.query("BEGIN")
        await locker.query("LOCK TABLE public.citation IN ACCESS EXCLUSIVE MODE")
        return async () => {
          await locker.query("ROLLBACK")
          await locker.end()
        }
      },
    },
    {
      name: "u3 a revoked grant on v_authority_citation",
      arrange: async () => {
        await ifExists("public.v_authority_citation", "REVOKE SELECT ON public.v_authority_citation FROM corpus_authority_reader")
        return () => ifExists("public.v_authority_citation", "GRANT SELECT ON public.v_authority_citation TO corpus_authority_reader")
      },
    },
    {
      name: "u4 a stale last_refresh",
      arrange: async () => {
        const saved = (await db.admin.query("SELECT value FROM corpus_metadata WHERE key = 'last_refresh'")).rows[0]?.value as string
        await db.admin.query("UPDATE corpus_metadata SET value = '2000-01-01T00:00:00.000000Z' WHERE key = 'last_refresh'")
        return async () => {
          await db.admin.query("UPDATE corpus_metadata SET value = $1 WHERE key = 'last_refresh'", [saved])
        }
      },
    },
    {
      name: "u5 a missing publication contract",
      arrange: async () => {
        const saved = (await db.admin.query("SELECT value FROM corpus_metadata WHERE key = 'publication_contract'")).rows[0]?.value as string
        await db.admin.query("DELETE FROM corpus_metadata WHERE key = 'publication_contract'")
        return async () => {
          await db.admin.query("INSERT INTO corpus_metadata (key, value) VALUES ('publication_contract', $1)", [saved])
        }
      },
    },
    { name: "u6 an unset environment", arrange: async () => setEnv("SIKANDER_CORPUS_READER_URL", undefined) },
    {
      name: "u7 a missing view",
      arrange: async () => {
        await ifExists("public.v_authority_citation", "ALTER VIEW public.v_authority_citation RENAME TO v_authority_citation_gone")
        return () => ifExists("public.v_authority_citation_gone", "ALTER VIEW public.v_authority_citation_gone RENAME TO v_authority_citation")
      },
    },
    { name: "u8 the wrong role (the writer's login as the reader)", arrange: async () => setEnv("SIKANDER_CORPUS_READER_URL", db.writerUrl) },
  ]

  it.each(unavailable)("F05-u each unavailable corpus gives UNVERIFIED or TEMPORAL_UNAVAILABLE, never OK, and approval is 409: $name", async (c) => {
    const f = await newFirm()
    const d = await create(f, `${cites("2099 SCMR 101")}\n${pleads(V2)}`)
    const check = { sectionId: S5, asAtDate: "2099-08-01", jurisdiction: "FEDERAL", usedText: V2 }
    const restore = await c.arrange()
    try {
      await resetAuthorityStore()
      const started = Date.now()
      const g = await gate(f, d.draftId, [check])
      if (c.budgetMs) expect(Date.now() - started).toBeLessThan(c.budgetMs)
      expect(g.citations).toEqual([{ ref: "2099 SCMR 101", judgmentId: null, status: "UNVERIFIED" }])
      expect(g.temporal).toEqual([{ ...check, status: "TEMPORAL_UNAVAILABLE", inForceText: null }])
      expect(g.status).toBe("UNVERIFIED")
      expectErr(await apiErrorOf(approve(f, d.draftId)), 409, "gate_blocked")
    } finally {
      await restore()
      await resetAuthorityStore()
    }
  }, SLOW)

  it("F05-f an overruling published after an OK gate makes approval 409 gate_blocked", async () => {
    const f = await newFirm()
    const d = await create(f, cites("2099 SCMR 101"))
    expect((await gate(f, d.draftId)).status).toBe("OK")
    const late = await db.publish(LATE_BATCH)
    expect(primary(late, "t-late")).toMatchObject({ decision: "promoted", reason: null })
    await resetAuthorityStore()
    expectErr(await apiErrorOf(approve(f, d.draftId)), 409, "gate_blocked")
    const shown = (await report(f, d.draftId)).gateResult
    expect(shown?.status).toBe("OVERRULED")
    expect(shown?.citations).toEqual([{ ref: "2099 SCMR 101", judgmentId: J["j-verified"], status: "OVERRULED" }])
    expect(await draftDoc(d.draftId)).toMatchObject({ status: "draft", locked: false })
  }, SLOW)
})
