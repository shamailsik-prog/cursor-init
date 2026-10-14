import { createHash, randomUUID } from "node:crypto"
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { getDocumentType, listDocumentTypes, reviewChecklistOf } from "../src/d4/doctypes"
import { ApiError, apiErrorOf, viaApi } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"

/**
 * Phase 4a Task 2 (spec P4-4, P4-5, P4-10..P4-12): the D4-1 draft store and the document-type routes,
 * through the HTTP router over the Auth and Firestore emulators. A firm is seeded once per describe
 * block (one matter, one member of each role, a partner who is not a member); each test makes its own
 * drafts. Every stored value is read back with the Admin SDK, so a response alone never proves a write.
 */

type View = {
  draftId: string
  matterId: string
  documentTypeId: string
  title: string
  classification: string
  status: string
  currentVersion: number
  currentBodySha256: string
  locked: boolean
  masterVersion: null
  gateResult: null | Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
  approvedBy?: string
}
type Read = View & { version: number; body: string }
type Saved = { saved: boolean; draft: View }
type VersionMeta = { version: number; bodySha256: string; kind: string; restoredFrom?: number; createdBy: string; createdAt: string }
type Page<T> = { items: T[]; nextCursor: string | null }
type TypeRow = { id: string; name: string; category: string; posture: string; courtIds: string[] }

const createApi = viaApi<View>("createDraft")
const saveApi = viaApi<Saved>("saveDraftVersion")
const restoreApi = viaApi<Saved>("restoreDraftVersion")
const getApi = viaApi<Read>("getDraft")
const listApi = viaApi<Page<View>>("listDrafts")
const versionsApi = viaApi<Page<VersionMeta>>("listDraftVersions")
const typesApi = viaApi<Page<TypeRow>>("listDocumentTypes")
const profileApi = viaApi<Record<string, unknown>>("getTypeProfile")
const gateApi = viaApi<{ draftId: string; version: number; status: string; resultId: string }>("gateDraft")

const TYPE = "constitutional_petition_199" // courts BHC, IHC, LHC, PHC, SHC
const SC_ONLY_TYPE = "constitutional_petition_184_3" // SC_PK only
const NON_FORUM_TYPE = "memorandum_of_association" // NON_FORUM
const FAMILY_TYPE = "bail_application_497" // lists the family DSJ_KHI_*

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const BODY = "IN THE HIGH COURT. The petitioner submits as follows.\nThe respondents have failed to act."
const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Member = { uid: string; token: string }
type Firm = {
  firmId: string
  matterId: string
  P: Member
  A: Member
  C: Member
  intern: Member
  accounts: Member
  client: Member
  /** A partner of the firm who is not a member of the matter. */
  outsider: Member
}

async function addMember(firmId: string, matterId: string, uid: string): Promise<void> {
  await adminDb().collection("matter_members").doc(`${matterId}_${uid}`).set({ firmId, matterId, userId: uid, classification: "internal" })
}

async function seedMatter(firmId: string, classification: string, courtId?: string): Promise<string> {
  const matterId = uniq("matter")
  await adminDb()
    .collection("matters")
    .doc(matterId)
    .set({ firmId, classification, title: "Recovery suit", stage: "pre_filing", status: "open", createdAt: Timestamp.now(), ...(courtId === undefined ? {} : { courtId }) })
  return matterId
}

async function newFirm(o: { classification?: string; courtId?: string } = {}): Promise<Firm> {
  const firmId = uniq("firm")
  // A high per-minute limit: one firm serves a whole describe block.
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", rateLimits: { general: 1000 } })
  const matterId = await seedMatter(firmId, o.classification ?? "internal", o.courtId)
  const mint = async (role: string, member = true): Promise<Member> => {
    const m = await mintIdToken(claims(firmId, role))
    if (member) await addMember(firmId, matterId, m.uid)
    return m
  }
  const [P, A, C, intern, accounts, client, outsider] = [
    await mint("partner"),
    await mint("associate"),
    await mint("clerk"),
    await mint("intern"),
    await mint("accounts"),
    await mint("client"),
    await mint("partner", false),
  ]
  return { firmId, matterId, P, A, C, intern, accounts, client, outsider }
}

/** A member of the firm's matter with the given role and clearance. */
async function memberOf(f: Firm, role: string, clearance: string): Promise<Member> {
  const m = await mintIdToken(claims(f.firmId, role, clearance))
  await addMember(f.firmId, f.matterId, m.uid)
  return m
}

const send = <T>(api: (c: never) => Promise<T>, f: Firm, m: Member, data: Record<string, unknown>): Promise<T> =>
  api({ token: m.token, data: { firmId: f.firmId, ...data } } as never)

const draftData = (f: Firm, extra: Record<string, unknown> = {}) => ({
  matterId: f.matterId,
  documentTypeId: TYPE,
  title: "Petition against the impugned order",
  body: BODY,
  ...extra,
})

const create = (f: Firm, m: Member = f.P, extra: Record<string, unknown> = {}) => send(createApi, f, m, draftData(f, extra))
const save = (f: Firm, m: Member, draftId: string, baseVersion: unknown, title: string, body: string) =>
  send(saveApi, f, m, { draftId, baseVersion, title, body })
const restore = (f: Firm, m: Member, draftId: string, baseVersion: unknown, fromVersion: unknown) =>
  send(restoreApi, f, m, { draftId, baseVersion, fromVersion })

function expectErr(err: ApiError, status: number, code: string): void {
  expect({ status: err.status, code: err.code }).toEqual({ status, code })
}

const draftDoc = async (id: string) => (await adminDb().collection("drafts").doc(id).get()).data()
const versionDoc = async (id: string, n: number) => (await adminDb().collection("draft_versions").doc(`${id}_${n}`).get()).data()
const eventDoc = async (id: string, n: number) => (await adminDb().collection("events").doc(`${id}_${n}_autosaved`).get()).data()
const byFirm = async (collection: string, firmId: string): Promise<Array<{ id: string; data: DocumentData }>> =>
  (await adminDb().collection(collection).where("firmId", "==", firmId).get()).docs.map((d) => ({ id: d.id, data: d.data() }))
const draftEvents = async (firmId: string, draftId: string) =>
  (await byFirm("events", firmId)).filter((e) => e.data.payload?.draftId === draftId)
/** The route's own CallAudit rows for the draft (the decision rows: target drafts/<id>). */
const callAudit = async (actorId: string, action: string, draftId: string) =>
  (await adminDb().collection("audit_log").where("actorId", "==", actorId).where("action", "==", action).where("target", "==", `drafts/${draftId}`).get()).docs.map((d) => d.data())
/** Every audit row whose target is the draft (the route's own CallAudit rows, whatever the action and decision). */
const draftAudit = async (draftId: string) =>
  (await adminDb().collection("audit_log").where("target", "==", `drafts/${draftId}`).get()).docs.map((d) => d.data())
const nothingStored = async (f: Firm) => {
  expect(await byFirm("drafts", f.firmId)).toHaveLength(0)
  expect(await byFirm("draft_versions", f.firmId)).toHaveLength(0)
  expect(await byFirm("events", f.firmId)).toHaveLength(0)
}

describe.skipIf(!EMULATORS)("createDraft (P4-4, P4-5, P4-12)", () => {
  it("creates the draft, version 1 (kind create), the draft.autosaved event and the audit row in one go", async () => {
    const f = await newFirm()
    const view = await create(f)
    expect(view).toEqual({
      draftId: view.draftId,
      matterId: f.matterId,
      documentTypeId: TYPE,
      title: "Petition against the impugned order",
      classification: "internal",
      status: "draft",
      currentVersion: 1,
      currentBodySha256: sha(BODY),
      locked: false,
      masterVersion: null,
      gateResult: null,
      createdBy: f.P.uid,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    })
    expect(view.draftId).toMatch(/^[A-Za-z0-9]{20}$/)
    expect(new Date(view.createdAt).toISOString()).toBe(view.createdAt)
    expect(view.updatedAt).toBe(view.createdAt)

    const stored = await draftDoc(view.draftId)
    expect(stored).toMatchObject({
      firmId: f.firmId,
      matterId: f.matterId,
      documentTypeId: TYPE,
      title: "Petition against the impugned order",
      classification: "internal",
      status: "draft",
      currentVersion: 1,
      currentBodySha256: sha(BODY),
      locked: false,
      masterVersion: null,
      gateResult: null,
      createdBy: f.P.uid,
    })
    expect(stored?.createdAt).toBeInstanceOf(Timestamp)
    expect(stored?.updatedAt).toBeInstanceOf(Timestamp)
    expect(stored).not.toHaveProperty("approvedBy")
    expect(stored).not.toHaveProperty("body")

    const v1 = await versionDoc(view.draftId, 1)
    expect(v1).toMatchObject({
      firmId: f.firmId,
      matterId: f.matterId,
      draftId: view.draftId,
      version: 1,
      title: "Petition against the impugned order",
      body: BODY,
      bodySha256: sha(BODY),
      classification: "internal",
      kind: "create",
      createdBy: f.P.uid,
    })
    expect(v1?.createdAt).toBeInstanceOf(Timestamp)
    expect(v1).not.toHaveProperty("restoredFrom")

    const event = await eventDoc(view.draftId, 1)
    expect(event).toMatchObject({
      name: "draft.autosaved",
      firmId: f.firmId,
      classification: "internal",
      payload: { draftId: view.draftId, matterId: f.matterId, documentTypeId: TYPE, version: 1, gateResult: null, masterVersion: null },
      idempotencyKey: `${view.draftId}:1:autosaved`,
    })
    expect(Object.keys(event?.payload as object).sort()).toEqual(["documentTypeId", "draftId", "gateResult", "masterVersion", "matterId", "version"])
    expect(event?.occurredAt).toBeInstanceOf(Timestamp)
    expect(await draftEvents(f.firmId, view.draftId)).toHaveLength(1)

    const rows = await callAudit(f.P.uid, "draft.create", view.draftId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firmId: f.firmId, decision: "allow", reason: "ok" })
  })

  it("partner, associate and clerk members can create; the creator is the authenticated caller", async () => {
    const f = await newFirm()
    for (const m of [f.P, f.A, f.C]) {
      const view = await create(f, m)
      expect(view.createdBy).toBe(m.uid)
      expect((await draftDoc(view.draftId))?.createdBy).toBe(m.uid)
    }
  })

  it("stores the NFC-normalised text and hashes that stored text; the title is trimmed", async () => {
    const f = await newFirm()
    const body = "Cafe\u0301 term.\r\nSecond line."
    const view = await create(f, f.P, { title: "  Reply to the notice  ", body })
    const stored = "Caf\u00e9 term.\nSecond line."
    expect(view.title).toBe("Reply to the notice")
    expect(view.currentBodySha256).toBe(sha(stored))
    expect((await versionDoc(view.draftId, 1))?.body).toBe(stored)
    expect((await versionDoc(view.draftId, 1))?.bodySha256).toBe(sha(stored))
  })

  it("an empty body is a draft (the editor starts blank)", async () => {
    const f = await newFirm()
    const view = await create(f, f.P, { body: "" })
    expect(view.currentBodySha256).toBe(sha(""))
    expect((await versionDoc(view.draftId, 1))?.body).toBe("")
  })

  describe("input checks, in order, before the permission", () => {
    // [name, status, code, patch]: the title reads the first three in order, so every row has its own readable title.
    const cases: Array<[string, number, string, Record<string, unknown>]> = [
      ["matterId missing", 400, "matter_required", { matterId: undefined }],
      ["matterId empty", 400, "matter_required", { matterId: "" }],
      ["matterId not a string", 400, "matter_required", { matterId: 5 }],
      ["documentTypeId missing", 400, "invalid_document_type", { documentTypeId: undefined }],
      ["documentTypeId empty", 400, "invalid_document_type", { documentTypeId: "" }],
      ["documentTypeId not a string", 400, "invalid_document_type", { documentTypeId: 7 }],
      ["documentTypeId unknown", 404, "document_type_not_found", { documentTypeId: "no_such_type" }],
      ["documentTypeId an Object.prototype key", 404, "document_type_not_found", { documentTypeId: "constructor" }],
      ["title missing", 400, "invalid_title", { title: undefined }],
      ["title blank", 400, "invalid_title", { title: "   " }],
      ["title not a string", 400, "invalid_title", { title: 3 }],
      ["body missing", 400, "invalid_body", { body: undefined }],
      ["body null", 400, "invalid_body", { body: null }],
      ["body not a string", 400, "invalid_body", { body: 12 }],
      ["classification not a label", 400, "invalid_classification", { classification: "secret" }],
      ["classification not a string", 400, "invalid_classification", { classification: 3 }],
      ["classification an Object.prototype key", 400, "invalid_classification", { classification: "constructor" }],
      ["classification null", 400, "invalid_classification", { classification: null }],
    ]
    it.each(cases)("%s → %i %s, nothing stored", async (_name, status, code, patch) => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.P, patch)), status, code)
      await nothingStored(f)
    })

    it("the checks run in the stated order: matter, type, title, body, classification", async () => {
      const f = await newFirm()
      const bad: Record<string, unknown> = { matterId: undefined, documentTypeId: "", title: "", body: null, classification: "secret" }
      const order: Array<[string, unknown, string]> = [
        ["matterId", f.matterId, "invalid_document_type"],
        ["documentTypeId", TYPE, "invalid_title"],
        ["title", "A title", "invalid_body"],
        ["body", BODY, "invalid_classification"],
      ]
      expectErr(await apiErrorOf(create(f, f.P, bad)), 400, "matter_required")
      for (const [field, fix, code] of order) {
        bad[field] = fix
        expectErr(await apiErrorOf(create(f, f.P, bad)), 400, code)
      }
      bad.classification = "internal"
      expect(await create(f, f.P, bad)).toMatchObject({ classification: "internal" })
    })

    // R-ruling: a title is one line of text. Any C0 or C1 control (the whitespace ones \n, \r, \t included), DEL too, is
    // 400 invalid_title, judged on the raw title (before it is trimmed) and before the charset functions.
    const CONTROLS: Array<[string, string]> = [
      ["LF", "\n"],
      ["CR", "\r"],
      ["TAB", "\t"],
      ["NUL", "\u0000"],
      ["BEL", "\u0007"],
      ["VT", "\u000b"],
      ["FF", "\u000c"],
      ["ESC", "\u001b"],
      ["US", "\u001f"],
      ["DEL", "\u007f"],
      ["PAD (C1)", "\u0080"],
      ["NEL (C1)", "\u0085"],
      ["APC (C1)", "\u009f"],
    ]
    it.each(CONTROLS)("a title with %s inside is 400 invalid_title, nothing stored", async (_name, ch) => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.P, { title: `Petition${ch}against the order` })), 400, "invalid_title")
      await nothingStored(f)
    })

    it("a title with a control at either end is refused too (it is judged before the trim)", async () => {
      const f = await newFirm()
      for (const title of ["Petition\n", "\tPetition", "\r\nPetition", "Petition\u0085"]) {
        expectErr(await apiErrorOf(create(f, f.P, { title })), 400, "invalid_title")
      }
      await nothingStored(f)
    })

    it("a control in the title is invalid_title, not unsupported_characters, when the title also has a hostile character", async () => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.P, { title: "Petition\n\u202e" })), 400, "invalid_title")
    })

    it("ordinary spaces are fine, trimmed at the ends; a control in the body is not a title problem", async () => {
      const f = await newFirm()
      const view = await create(f, f.P, { title: "  Petition against  the order  ", body: "Line one.\nLine two.\tTabbed." })
      expect(view.title).toBe("Petition against  the order")
    })

    it("the checks come before the permission: an intern with a bad title gets 400, not 403", async () => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.intern, { title: "" })), 400, "invalid_title")
    })
  })

  describe("access (P4-10)", () => {
    it("an intern, a client and accounts are refused 403, and a partner who is not a member of the matter too; nothing is stored", async () => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.intern)), 403, "intern_channel_denied")
      expectErr(await apiErrorOf(create(f, f.client)), 403, "client_denied")
      expectErr(await apiErrorOf(create(f, f.accounts)), 403, "accounts_register_only")
      expectErr(await apiErrorOf(create(f, f.outsider)), 403, "not_member")
      await nothingStored(f)
    })

    it("a missing matter and another firm's matter are both 404 not_found (existence never leaks)", async () => {
      const f = await newFirm()
      const other = await newFirm()
      expectErr(await apiErrorOf(create(f, f.P, { matterId: "no-such-matter" })), 404, "not_found")
      expectErr(await apiErrorOf(create(f, f.P, { matterId: other.matterId })), 404, "not_found")
      await nothingStored(other)
    })

    it("a malformed matter id is refused, not queried", async () => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.P, { matterId: "a/b" })), 403, "invalid_matter_id")
    })

    it("clearance below the matter's label is 403 clearance; a matter with an unreadable label fails closed the same way", async () => {
      const f = await newFirm({ classification: "privileged" })
      const low = await memberOf(f, "associate", "confidential")
      expectErr(await apiErrorOf(create(f, low)), 403, "clearance")
      const bogus = await seedMatter(f.firmId, "bogus")
      await addMember(f.firmId, bogus, f.P.uid)
      expectErr(await apiErrorOf(create(f, f.P, { matterId: bogus })), 403, "clearance")
      await nothingStored(f)
    })

    it("a refusal is audited as a deny under draft.create", async () => {
      const f = await newFirm()
      await apiErrorOf(create(f, f.intern))
      const rows = (await adminDb().collection("audit_log").where("actorId", "==", f.intern.uid).where("action", "==", "draft.create").get()).docs.map((d) => d.data())
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((r) => r.decision === "deny")).toBe(true)
    })
  })

  describe("the court check (P4-5, E-15)", () => {
    it("a type that does not list the matter's court is 422 court_mismatch, nothing stored", async () => {
      const f = await newFirm({ courtId: "SHC" })
      expectErr(await apiErrorOf(create(f, f.P, { documentTypeId: SC_ONLY_TYPE })), 422, "court_mismatch")
      await nothingStored(f)
    })

    it("a type that lists the court, a family that admits it, a NON_FORUM type and a matter with no court are accepted", async () => {
      const shc = await newFirm({ courtId: "SHC" })
      expect(await create(shc, shc.P, { documentTypeId: TYPE })).toMatchObject({ documentTypeId: TYPE })
      expect(await create(shc, shc.P, { documentTypeId: NON_FORUM_TYPE })).toMatchObject({ documentTypeId: NON_FORUM_TYPE })
      const sessions = await newFirm({ courtId: "DSJ_KHI_EAST" })
      expect(await create(sessions, sessions.P, { documentTypeId: FAMILY_TYPE })).toMatchObject({ documentTypeId: FAMILY_TYPE })
      const invented = await newFirm({ courtId: "MADE_UP_COURT" })
      expect(await create(invented, invented.P, { documentTypeId: NON_FORUM_TYPE })).toMatchObject({ documentTypeId: NON_FORUM_TYPE })
      const none = await newFirm()
      expect(await create(none, none.P, { documentTypeId: SC_ONLY_TYPE })).toMatchObject({ documentTypeId: SC_ONLY_TYPE })
    })
  })

  describe("classification (P4-5, L17.3 #20: monotonic)", () => {
    it("with no label the draft takes the matter's", async () => {
      const f = await newFirm({ classification: "confidential" })
      const view = await create(f)
      expect(view.classification).toBe("confidential")
      expect((await versionDoc(view.draftId, 1))?.classification).toBe("confidential")
      expect((await eventDoc(view.draftId, 1))?.classification).toBe("confidential")
    })

    it("a caller label at or above the matter's is the draft's (the stricter)", async () => {
      const f = await newFirm({ classification: "confidential" })
      expect((await create(f, f.P, { classification: "confidential" })).classification).toBe("confidential")
      const higher = await create(f, f.P, { classification: "privileged" })
      expect(higher.classification).toBe("privileged")
      expect((await draftDoc(higher.draftId))?.classification).toBe("privileged")
      expect((await versionDoc(higher.draftId, 1))?.classification).toBe("privileged")
      expect((await eventDoc(higher.draftId, 1))?.classification).toBe("privileged")
    })

    it("a caller label below the matter's is 422 classification_below_matter, nothing stored", async () => {
      const f = await newFirm({ classification: "confidential" })
      for (const label of ["public", "internal"]) {
        expectErr(await apiErrorOf(create(f, f.P, { classification: label })), 422, "classification_below_matter")
      }
      await nothingStored(f)
    })

    it("a label above the caller's clearance is 403 clearance", async () => {
      const f = await newFirm({ classification: "internal" })
      const low = await memberOf(f, "associate", "confidential")
      expectErr(await apiErrorOf(create(f, low, { classification: "privileged" })), 403, "clearance")
      expect(await create(f, low, { classification: "confidential" })).toMatchObject({ classification: "confidential" })
    })

    describe("the internal floor (R3: caller-authored text is never rank 0, as committeeBrain)", () => {
      it("a public matter gives an internal draft: the draft, version 1 and the event are labelled internal", async () => {
        const f = await newFirm({ classification: "public" })
        const view = await create(f)
        expect(view.classification).toBe("internal")
        expect((await draftDoc(view.draftId))?.classification).toBe("internal")
        expect((await versionDoc(view.draftId, 1))?.classification).toBe("internal")
        expect((await eventDoc(view.draftId, 1))?.classification).toBe("internal")
      })

      it("a public request on a public matter is floored to internal, not refused", async () => {
        const f = await newFirm({ classification: "public" })
        const view = await create(f, f.P, { classification: "public" })
        expect(view.classification).toBe("internal")
        expect((await versionDoc(view.draftId, 1))?.classification).toBe("internal")
      })

      it("a higher request on a public matter is the stricter, as before", async () => {
        const f = await newFirm({ classification: "public" })
        expect((await create(f, f.P, { classification: "confidential" })).classification).toBe("confidential")
        expect((await create(f, f.P, { classification: "internal" })).classification).toBe("internal")
      })

      it("classification_below_matter stays relative to the matter's own label: an internal matter refuses public", async () => {
        const f = await newFirm({ classification: "internal" })
        expectErr(await apiErrorOf(create(f, f.P, { classification: "public" })), 422, "classification_below_matter")
        await nothingStored(f)
      })

      it("a caller cleared only to public gets 403 clearance on a public matter (the floor is the result the clearance must reach)", async () => {
        const f = await newFirm({ classification: "public" })
        const publicOnly = await memberOf(f, "associate", "public")
        expectErr(await apiErrorOf(create(f, publicOnly)), 403, "clearance")
        expectErr(await apiErrorOf(create(f, publicOnly, { classification: "public" })), 403, "clearance")
        await nothingStored(f)
        const internal = await memberOf(f, "associate", "internal")
        expect(await create(f, internal)).toMatchObject({ classification: "internal" })
      })

      it("saves and restores on a floored draft carry its internal label on the versions and the events", async () => {
        const f = await newFirm({ classification: "public" })
        const v1 = await create(f)
        await save(f, f.P, v1.draftId, 1, "Second title", "Second body.")
        await restore(f, f.P, v1.draftId, 2, 1)
        for (const n of [1, 2, 3]) {
          expect([n, (await versionDoc(v1.draftId, n))?.classification]).toEqual([n, "internal"])
          expect([n, (await eventDoc(v1.draftId, n))?.classification]).toEqual([n, "internal"])
        }
        expect((await draftDoc(v1.draftId))?.classification).toBe("internal")
      })
    })
  })

  describe("a closed matter (R4)", () => {
    it("createDraft on a closed matter is 409 matter_closed, nothing stored", async () => {
      const f = await newFirm()
      await adminDb().collection("matters").doc(f.matterId).update({ status: "closed", closedBy: f.P.uid })
      expectErr(await apiErrorOf(create(f, f.P)), 409, "matter_closed")
      expectErr(await apiErrorOf(create(f, f.A)), 409, "matter_closed")
      await nothingStored(f)
    })

    it("the permission still comes first: an intern or a non-member on a closed matter is refused 403, not told it is closed", async () => {
      const f = await newFirm()
      await adminDb().collection("matters").doc(f.matterId).update({ status: "closed" })
      expectErr(await apiErrorOf(create(f, f.intern)), 403, "intern_channel_denied")
      expectErr(await apiErrorOf(create(f, f.outsider)), 403, "not_member")
    })

    it("a matter that is open (or has no status) still takes new drafts", async () => {
      const f = await newFirm()
      expect(await create(f)).toMatchObject({ currentVersion: 1 })
      await adminDb().collection("matters").doc(f.matterId).update({ status: FieldValue.delete() })
      expect(await create(f)).toMatchObject({ currentVersion: 1 })
    })

    it("saves and restores on an existing draft of a closed matter stay allowed (recorded for later)", async () => {
      const f = await newFirm()
      const v1 = await create(f, f.P, { title: "Original title", body: "Original body." })
      await adminDb().collection("matters").doc(f.matterId).update({ status: "closed", closedBy: f.P.uid })
      expect(await save(f, f.P, v1.draftId, 1, "Edited title", "Edited body.")).toMatchObject({ saved: true, draft: { currentVersion: 2 } })
      expect(await restore(f, f.P, v1.draftId, 2, 1)).toMatchObject({ saved: true, draft: { currentVersion: 3, title: "Original title" } })
      expect(await send(getApi, f, f.P, { draftId: v1.draftId })).toMatchObject({ version: 3 })
    })
  })

  describe("text checks (SEC-1, R3): refused, never stored", () => {
    it("a body with a bidirectional control is 422 unsupported_characters", async () => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.P, { body: "The respondent\u202e paid." })), 422, "unsupported_characters")
      await nothingStored(f)
    })

    it("a title with an invisible character, or a body with a confusable Cyrillic letter in a Latin word, is 422 unsupported_characters", async () => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.P, { title: "Petition\u2066" })), 422, "unsupported_characters")
      expectErr(await apiErrorOf(create(f, f.P, { body: "The \u0441ourt held" })), 422, "unsupported_characters")
      await nothingStored(f)
    })

    it("a title over 500 characters is 422 title_too_long; 500 is accepted", async () => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.P, { title: "T".repeat(501) })), 422, "title_too_long")
      await nothingStored(f)
      expect((await create(f, f.P, { title: "T".repeat(500) })).title).toHaveLength(500)
    })

    it("a body over 500,000 characters is 422 draft_too_large", async () => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.P, { body: "a".repeat(500_001) })), 422, "draft_too_large")
      await nothingStored(f)
    })

    it("an Urdu body over 900,000 UTF-8 bytes but under 500,000 characters is 422 draft_too_large, not truncated; 900,000 bytes is accepted", async () => {
      const f = await newFirm()
      const over = "\u0627".repeat(450_001) // 450,001 characters, 900,002 bytes
      expect(over.length).toBeLessThan(500_000)
      expect(Buffer.byteLength(over, "utf8")).toBeGreaterThan(900_000)
      expectErr(await apiErrorOf(create(f, f.P, { body: over })), 422, "draft_too_large")
      await nothingStored(f)
      const atCap = "\u0627".repeat(450_000) // exactly 900,000 bytes
      const view = await create(f, f.P, { body: atCap })
      expect(view.currentBodySha256).toBe(sha(atCap))
      expect((await versionDoc(view.draftId, 1))?.body).toHaveLength(450_000)
    }, 60_000)

    it("a hostile body from a caller who is not allowed is refused for the permission first (no oracle)", async () => {
      const f = await newFirm()
      expectErr(await apiErrorOf(create(f, f.intern, { body: "x\u202e" })), 403, "intern_channel_denied")
    })
  })

  it("a retry with the same Idempotency-Key replays the first answer and stores one draft", async () => {
    const f = await newFirm()
    const key = randomUUID()
    const call = () => createApi({ token: f.P.token, headers: { "idempotency-key": key }, data: { firmId: f.firmId, ...draftData(f) } } as never)
    const first = await call()
    const second = await call()
    expect(second.draftId).toBe(first.draftId)
    expect(await byFirm("drafts", f.firmId)).toHaveLength(1)
    expect(await draftEvents(f.firmId, first.draftId)).toHaveLength(1)
  })
})

describe.skipIf(!EMULATORS)("saveDraftVersion (P4-4, P4-12)", () => {
  it("writes version 2 (kind save), updates the draft, writes the event and the audit row, and answers saved: true", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    const out = await save(f, f.A, v1.draftId, 1, "Revised petition", `${BODY}\nA new paragraph.`)
    const body = `${BODY}\nA new paragraph.`
    expect(out.saved).toBe(true)
    expect(out.draft).toMatchObject({
      draftId: v1.draftId,
      title: "Revised petition",
      currentVersion: 2,
      currentBodySha256: sha(body),
      locked: false,
      status: "draft",
      gateResult: null,
      createdBy: f.P.uid,
      createdAt: v1.createdAt,
    })
    expect(Date.parse(out.draft.updatedAt)).toBeGreaterThanOrEqual(Date.parse(v1.updatedAt))

    const stored = await draftDoc(v1.draftId)
    expect(stored).toMatchObject({ title: "Revised petition", currentVersion: 2, currentBodySha256: sha(body), createdBy: f.P.uid })
    const v2 = await versionDoc(v1.draftId, 2)
    expect(v2).toMatchObject({ firmId: f.firmId, matterId: f.matterId, draftId: v1.draftId, version: 2, title: "Revised petition", body, bodySha256: sha(body), classification: "internal", kind: "save", createdBy: f.A.uid })
    expect(v2).not.toHaveProperty("restoredFrom")
    expect(await versionDoc(v1.draftId, 1)).toMatchObject({ version: 1, body: BODY, kind: "create" })
    expect(await eventDoc(v1.draftId, 2)).toMatchObject({
      name: "draft.autosaved",
      payload: { draftId: v1.draftId, matterId: f.matterId, documentTypeId: TYPE, version: 2, gateResult: null, masterVersion: null },
      idempotencyKey: `${v1.draftId}:2:autosaved`,
      classification: "internal",
    })
    expect(await draftEvents(f.firmId, v1.draftId)).toHaveLength(2)
    const rows = await callAudit(f.A.uid, "draft.edit", v1.draftId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firmId: f.firmId, decision: "allow", reason: "ok" })
  })

  it("a changed title alone, or a changed body alone, is a new version", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    const titleOnly = await save(f, f.P, v1.draftId, 1, "Another title", BODY)
    expect(titleOnly).toMatchObject({ saved: true, draft: { currentVersion: 2, title: "Another title", currentBodySha256: sha(BODY) } })
    const bodyOnly = await save(f, f.P, v1.draftId, 2, "Another title", `${BODY} More.`)
    expect(bodyOnly).toMatchObject({ saved: true, draft: { currentVersion: 3, title: "Another title", currentBodySha256: sha(`${BODY} More.`) } })
  })

  it("an identical save (same title and body as the current version) writes nothing: saved false, the draft unchanged, one allow row, no event", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    const v2 = await save(f, f.P, v1.draftId, 1, "Second title", "Second body.")
    const eventsBefore = (await draftEvents(f.firmId, v1.draftId)).length
    const versionsBefore = (await byFirm("draft_versions", f.firmId)).length
    const rowsBefore = (await callAudit(f.P.uid, "draft.edit", v1.draftId)).length
    const storedBefore = await draftDoc(v1.draftId)

    const same = await save(f, f.P, v1.draftId, 2, "Second title", "Second body.")
    expect(same).toEqual({ saved: false, draft: v2.draft })
    expect(await draftDoc(v1.draftId)).toEqual(storedBefore)
    expect(await draftEvents(f.firmId, v1.draftId)).toHaveLength(eventsBefore)
    expect(await byFirm("draft_versions", f.firmId)).toHaveLength(versionsBefore)
    expect(await versionDoc(v1.draftId, 3)).toBeUndefined()
    const rowsAfter = await callAudit(f.P.uid, "draft.edit", v1.draftId)
    expect(rowsAfter).toHaveLength(rowsBefore + 1)
    expect(rowsAfter.every((r) => r.decision === "allow")).toBe(true)
  })

  it("an identical save is judged on the stored (normalised) text: the same text with CRLF and untrimmed padding is identical", async () => {
    const f = await newFirm()
    const v1 = await create(f, f.P, { body: "Line one.\nLine two." })
    const same = await save(f, f.P, v1.draftId, 1, `  ${v1.title}  `, "Line one.\r\nLine two.")
    expect(same.saved).toBe(false)
    expect(same.draft.currentVersion).toBe(1)
  })

  it("an identical save still needs the right baseVersion (a stale one is draft_changed, not a quiet no-op)", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    await save(f, f.P, v1.draftId, 1, "Second title", "Second body.")
    expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, v1.title, BODY)), 409, "draft_changed")
  })

  describe("baseVersion and the lock, checked inside the transaction", () => {
    it("a stale or a future baseVersion is 409 draft_changed and writes nothing", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      await save(f, f.P, v1.draftId, 1, "Second title", "Second body.")
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, "Third", "Third body.")), 409, "draft_changed")
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 3, "Third", "Third body.")), 409, "draft_changed")
      expect((await draftDoc(v1.draftId))?.currentVersion).toBe(2)
      expect(await versionDoc(v1.draftId, 3)).toBeUndefined()
      expect(await draftEvents(f.firmId, v1.draftId)).toHaveLength(2)
    })

    it("a refused stale save writes a deny row on the route's audit (draft.edit, drafts/<id>, reason draft_changed), and no event or version", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      await save(f, f.P, v1.draftId, 1, "Second title", "Second body.")
      const before = await callAudit(f.A.uid, "draft.edit", v1.draftId)
      expect(before).toHaveLength(0)
      expectErr(await apiErrorOf(save(f, f.A, v1.draftId, 1, "Third", "Third body.")), 409, "draft_changed")
      const rows = await callAudit(f.A.uid, "draft.edit", v1.draftId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ firmId: f.firmId, decision: "deny", reason: "draft_changed", action: "draft.edit", target: `drafts/${v1.draftId}` })
      expect(await versionDoc(v1.draftId, 3)).toBeUndefined()
      expect(await draftEvents(f.firmId, v1.draftId)).toHaveLength(2)
    })

    it("a refused save on a locked draft writes a deny row with reason draft_locked", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      await adminDb().collection("drafts").doc(v1.draftId).update({ locked: true })
      expectErr(await apiErrorOf(save(f, f.A, v1.draftId, 1, "Edited", "Edited body.")), 409, "draft_locked")
      const rows = await callAudit(f.A.uid, "draft.edit", v1.draftId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ firmId: f.firmId, decision: "deny", reason: "draft_locked", target: `drafts/${v1.draftId}` })
    })

    it("a baseVersion that is not a positive integer is 400 invalid_version", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      for (const bad of [undefined, null, 0, -1, 1.5, "1", true, [1], 2 ** 53]) {
        expectErr(await apiErrorOf(save(f, f.P, v1.draftId, bad, "T", "B")), 400, "invalid_version")
      }
      expect((await draftDoc(v1.draftId))?.currentVersion).toBe(1)
    })

    it("a locked draft is 409 draft_locked, and the lock is checked before the baseVersion", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      await adminDb().collection("drafts").doc(v1.draftId).update({ locked: true })
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, "Edited", "Edited body.")), 409, "draft_locked")
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 9, "Edited", "Edited body.")), 409, "draft_locked")
      expect((await draftDoc(v1.draftId))?.currentVersion).toBe(1)
      expect(await versionDoc(v1.draftId, 2)).toBeUndefined()
    })

    it("a locked draft refuses even an identical save (the lock is not a quiet success)", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      await adminDb().collection("drafts").doc(v1.draftId).update({ locked: true })
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, v1.title, BODY)), 409, "draft_locked")
    })

    it("two saves on the same base: exactly one succeeds, the other is draft_changed, and the versions are dense", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      const results = await Promise.allSettled([
        save(f, f.P, v1.draftId, 1, "Writer one", "Body by the first writer."),
        save(f, f.A, v1.draftId, 1, "Writer two", "Body by the second writer."),
      ])
      const ok = results.filter((r): r is PromiseFulfilledResult<Saved> => r.status === "fulfilled")
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
      expect(ok).toHaveLength(1)
      expect(failed).toHaveLength(1)
      expectErr(failed[0]!.reason as ApiError, 409, "draft_changed")
      expect(ok[0]!.value.saved).toBe(true)
      expect(ok[0]!.value.draft.currentVersion).toBe(2)

      const stored = await draftDoc(v1.draftId)
      expect(stored?.currentVersion).toBe(2)
      const versions = (await byFirm("draft_versions", f.firmId)).filter((v) => v.data.draftId === v1.draftId).map((v) => v.id).sort()
      expect(versions).toEqual([`${v1.draftId}_1`, `${v1.draftId}_2`])
      expect(stored?.currentBodySha256).toBe((await versionDoc(v1.draftId, 2))?.bodySha256)
      expect((await draftEvents(f.firmId, v1.draftId)).map((e) => e.id).sort()).toEqual([`${v1.draftId}_1_autosaved`, `${v1.draftId}_2_autosaved`])
      // the winner has its allow row, the loser a deny row with the reason draft_changed (both on the route's audit)
      const rows = [...(await callAudit(f.P.uid, "draft.edit", v1.draftId)), ...(await callAudit(f.A.uid, "draft.edit", v1.draftId))]
      expect(rows.map((r) => `${r.decision}:${r.reason}`).sort()).toEqual(["allow:ok", "deny:draft_changed"])
    })

    it("four saves racing on one base: exactly one wins, the rest are draft_changed, nothing is skipped", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      const results = await Promise.allSettled([1, 2, 3, 4].map((n) => save(f, f.P, v1.draftId, 1, `Racer ${n}`, `Body ${n}.`)))
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expectErr(r.reason as ApiError, 409, "draft_changed")
      expect((await draftDoc(v1.draftId))?.currentVersion).toBe(2)
      expect(await versionDoc(v1.draftId, 3)).toBeUndefined()
    })
  })

  it("sequential saves give dense versions 1..5, each with its own hash, and every version stays readable", async () => {
    const f = await newFirm()
    const v1 = await create(f, f.P, { body: "Body 1." })
    for (let n = 1; n < 5; n++) {
      const out = await save(f, f.P, v1.draftId, n, `Title ${n + 1}`, `Body ${n + 1}.`)
      expect(out.draft.currentVersion).toBe(n + 1)
    }
    for (let n = 1; n <= 5; n++) {
      expect(await versionDoc(v1.draftId, n)).toMatchObject({ version: n, title: n === 1 ? v1.title : `Title ${n}`, body: `Body ${n}.`, bodySha256: sha(`Body ${n}.`) })
    }
    expect(await versionDoc(v1.draftId, 6)).toBeUndefined()
    expect((await draftEvents(f.firmId, v1.draftId)).map((e) => e.id).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `${v1.draftId}_${n}_autosaved`))
    expect(await callAudit(f.P.uid, "draft.edit", v1.draftId)).toHaveLength(4)
  })

  it("a new version is not gated: the draft's gate summary is reset (the old result stays in draft_gate_results)", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    await adminDb().collection("drafts").doc(v1.draftId).update({ gateResult: { version: 1, bodySha256: v1.currentBodySha256, status: "OK", gatedAt: Timestamp.now(), overridden: false } })
    const out = await save(f, f.P, v1.draftId, 1, "Second title", "Second body.")
    expect(out.draft.gateResult).toBeNull()
    expect((await draftDoc(v1.draftId))?.gateResult).toBeNull()
  })

  it("the version carries the draft's classification, not a fresh one", async () => {
    const f = await newFirm({ classification: "confidential" })
    const v1 = await create(f, f.P, { classification: "privileged" })
    await save(f, f.P, v1.draftId, 1, "Second", "Second body.")
    expect((await versionDoc(v1.draftId, 2))?.classification).toBe("privileged")
    expect((await eventDoc(v1.draftId, 2))?.classification).toBe("privileged")
  })

  it("a version saved after the matter's label is raised carries the raised label", async () => {
    const f = await newFirm()
    const v1 = await create(f, f.A)
    expect(v1.classification).toBe("internal")
    // A member raises the matter's label after version 1 was written (the client SDK may: the matters update rule).
    await adminDb().collection("matters").doc(f.matterId).update({ classification: "privileged" })
    const s2 = await save(f, f.A, v1.draftId, 1, "Second", "Second body.")
    expect(s2.draft.classification).toBe("privileged")
    expect((await draftDoc(v1.draftId))?.classification).toBe("privileged")
    expect((await versionDoc(v1.draftId, 2))?.classification).toBe("privileged")
    expect((await eventDoc(v1.draftId, 2))?.classification).toBe("privileged")
    // Version 1 is immutable and keeps the label it was written with.
    expect((await versionDoc(v1.draftId, 1))?.classification).toBe("internal")
    // The new version's gate result and draft.gated event follow the draft's raised label.
    const g = await send(gateApi, f, f.A, { draftId: v1.draftId, version: 2 })
    expect(g.version).toBe(2)
    expect((await adminDb().collection("draft_gate_results").doc(`${v1.draftId}_2`).get()).data()?.classification).toBe("privileged")
    expect((await adminDb().collection("events").doc(`${v1.draftId}_2_gated_1`).get()).data()?.classification).toBe("privileged")
    // Monotonic: a later lowering of the matter's label never lowers the draft; a restore after it stays privileged.
    await adminDb().collection("matters").doc(f.matterId).update({ classification: "confidential" })
    await restore(f, f.A, v1.draftId, 2, 1)
    expect((await versionDoc(v1.draftId, 3))?.classification).toBe("privileged")
    expect((await eventDoc(v1.draftId, 3))?.classification).toBe("privileged")
    expect((await draftDoc(v1.draftId))?.classification).toBe("privileged")
  })

  describe("input and text checks", () => {
    it("draftId, title and body must be well formed (400), and nothing is stored", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      expectErr(await apiErrorOf(send(saveApi, f, f.P, { baseVersion: 1, title: "T", body: "B" })), 400, "invalid_query")
      expectErr(await apiErrorOf(send(saveApi, f, f.P, { draftId: 5, baseVersion: 1, title: "T", body: "B" })), 400, "invalid_query")
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, "", "B")), 400, "invalid_title")
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, "   ", "B")), 400, "invalid_title")
      expectErr(await apiErrorOf(send(saveApi, f, f.P, { draftId: v1.draftId, baseVersion: 1, title: 5, body: "B" })), 400, "invalid_title")
      expectErr(await apiErrorOf(send(saveApi, f, f.P, { draftId: v1.draftId, baseVersion: 1, title: "T", body: 5 })), 400, "invalid_body")
      expectErr(await apiErrorOf(send(saveApi, f, f.P, { draftId: v1.draftId, baseVersion: 1, title: "T" })), 400, "invalid_body")
      expect((await draftDoc(v1.draftId))?.currentVersion).toBe(1)
    })

    it("a title with a control character (LF, CR, TAB, any C0 or C1, DEL) is 400 invalid_title and stores nothing", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      for (const ch of ["\n", "\r", "\t", "\u0000", "\u001f", "\u007f", "\u0085", "\u009f"]) {
        expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, `Revised${ch}title`, "B")), 400, "invalid_title")
      }
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, "Revised title\n", "B")), 400, "invalid_title")
      expect((await draftDoc(v1.draftId))?.currentVersion).toBe(1)
      expect(await versionDoc(v1.draftId, 2)).toBeUndefined()
    })

    it("a hostile body or title is 422 unsupported_characters and stores nothing; an oversize title or body is 422 too", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, "T", "The respondent\u202e paid.")), 422, "unsupported_characters")
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, "Petition\u2066", "B")), 422, "unsupported_characters")
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, "T".repeat(501), "B")), 422, "title_too_long")
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, "T", "a".repeat(500_001))), 422, "draft_too_large")
      expectErr(await apiErrorOf(save(f, f.P, v1.draftId, 1, "T", "\u0627".repeat(450_001))), 422, "draft_too_large")
      expect((await draftDoc(v1.draftId))?.currentVersion).toBe(1)
      expect(await versionDoc(v1.draftId, 2)).toBeUndefined()
      expect(await draftEvents(f.firmId, v1.draftId)).toHaveLength(1)
    }, 60_000)
  })

  describe("access (P4-10)", () => {
    it("an intern, a client, accounts and a non-member partner are refused 403; nothing is stored", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      expectErr(await apiErrorOf(save(f, f.intern, v1.draftId, 1, "T", "B")), 403, "intern_channel_denied")
      expectErr(await apiErrorOf(save(f, f.client, v1.draftId, 1, "T", "B")), 403, "client_denied")
      expectErr(await apiErrorOf(save(f, f.accounts, v1.draftId, 1, "T", "B")), 403, "accounts_register_only")
      expectErr(await apiErrorOf(save(f, f.outsider, v1.draftId, 1, "T", "B")), 403, "not_member")
      expect((await draftDoc(v1.draftId))?.currentVersion).toBe(1)
    })

    it("a missing draft, a malformed id and another firm's draft are all 404 not_found", async () => {
      const f = await newFirm()
      const other = await newFirm()
      const theirs = await create(other)
      expectErr(await apiErrorOf(save(f, f.P, "no-such-draft", 1, "T", "B")), 404, "not_found")
      expectErr(await apiErrorOf(save(f, f.P, "a/b", 1, "T", "B")), 404, "not_found")
      expectErr(await apiErrorOf(save(f, f.P, theirs.draftId, 1, "T", "B")), 404, "not_found")
      expect((await draftDoc(theirs.draftId))?.currentVersion).toBe(1)
    })

    it("a draft above the caller's clearance is 404, and a caller whose clearance reaches it can edit", async () => {
      const f = await newFirm()
      const secret = await create(f, f.P, { classification: "privileged" })
      const low = await memberOf(f, "associate", "confidential")
      expectErr(await apiErrorOf(save(f, low, secret.draftId, 1, "T", "B")), 404, "not_found")
      const high = await memberOf(f, "associate", "privileged")
      expect(await save(f, high, secret.draftId, 1, "T", "B")).toMatchObject({ saved: true })
    })

    it("the permission is decided on the draft's own matter: a member of another matter of the firm is refused", async () => {
      const f = await newFirm()
      const v1 = await create(f)
      const otherMatter = await seedMatter(f.firmId, "internal")
      const m = await mintIdToken(claims(f.firmId, "partner"))
      await addMember(f.firmId, otherMatter, m.uid)
      expectErr(await apiErrorOf(save(f, m, v1.draftId, 1, "T", "B")), 403, "not_member")
    })
  })
})

describe.skipIf(!EMULATORS)("restoreDraftVersion (P4-4)", () => {
  it("restores an earlier version as a new one: kind restore, restoredFrom, the draft takes that title and body", async () => {
    const f = await newFirm()
    const v1 = await create(f, f.P, { title: "Original title", body: "Original body." })
    await save(f, f.P, v1.draftId, 1, "Edited title", "Edited body.")
    const out = await restore(f, f.A, v1.draftId, 2, 1)
    expect(out.saved).toBe(true)
    expect(out.draft).toMatchObject({ currentVersion: 3, title: "Original title", currentBodySha256: sha("Original body."), gateResult: null })
    expect(await versionDoc(v1.draftId, 3)).toMatchObject({
      version: 3,
      title: "Original title",
      body: "Original body.",
      bodySha256: sha("Original body."),
      kind: "restore",
      restoredFrom: 1,
      createdBy: f.A.uid,
      classification: "internal",
      draftId: v1.draftId,
      firmId: f.firmId,
      matterId: f.matterId,
    })
    expect(await versionDoc(v1.draftId, 2)).toMatchObject({ title: "Edited title", body: "Edited body.", kind: "save" })
    expect(await eventDoc(v1.draftId, 3)).toMatchObject({
      name: "draft.autosaved",
      payload: { draftId: v1.draftId, matterId: f.matterId, documentTypeId: TYPE, version: 3, gateResult: null, masterVersion: null },
    })
    expect(await draftEvents(f.firmId, v1.draftId)).toHaveLength(3)
    const rows = await callAudit(f.A.uid, "draft.edit", v1.draftId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ decision: "allow" })
  })

  it("restoring a version whose title and body equal the current one writes nothing (saved false)", async () => {
    const f = await newFirm()
    const v1 = await create(f, f.P, { title: "Same title", body: "Same body." })
    const v2 = await save(f, f.P, v1.draftId, 1, "Changed", "Changed body.")
    await save(f, f.P, v1.draftId, 2, "Same title", "Same body.") // v3 == v1's content
    const before = (await byFirm("draft_versions", f.firmId)).filter((v) => v.data.draftId === v1.draftId).length
    const eventsBefore = (await draftEvents(f.firmId, v1.draftId)).length
    const auditBefore = (await draftAudit(v1.draftId)).length
    const allowBefore = (await callAudit(f.P.uid, "draft.edit", v1.draftId)).filter((r) => r.decision === "allow").length
    const storedBefore = await draftDoc(v1.draftId)
    const out = await restore(f, f.P, v1.draftId, 3, 1)
    expect(out.saved).toBe(false)
    expect(out.draft.currentVersion).toBe(3)
    expect((await byFirm("draft_versions", f.firmId)).filter((v) => v.data.draftId === v1.draftId)).toHaveLength(before)
    // nothing but the call's own allow row: no event, no draft update, one more audit row on drafts/<id>
    expect(await draftEvents(f.firmId, v1.draftId)).toHaveLength(eventsBefore)
    expect(await draftDoc(v1.draftId)).toEqual(storedBefore)
    const auditAfter = await draftAudit(v1.draftId)
    expect(auditAfter).toHaveLength(auditBefore + 1)
    expect(auditAfter.filter((r) => r.decision === "allow" && r.action === "draft.edit" && r.actorId === f.P.uid)).toHaveLength(allowBefore + 1)
    expect(auditAfter.filter((r) => r.decision === "deny")).toHaveLength(0)
    // and the current version restored onto itself is identical too
    expect((await restore(f, f.P, v1.draftId, 3, 3)).saved).toBe(false)
    expect(await draftEvents(f.firmId, v1.draftId)).toHaveLength(eventsBefore)
    expect(await draftAudit(v1.draftId)).toHaveLength(auditBefore + 2)
    expect(v2.draft.currentVersion).toBe(2)
  })

  it("a fromVersion that does not exist is 404 version_not_found; a malformed one is 400 invalid_version", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    await save(f, f.P, v1.draftId, 1, "Second", "Second body.")
    expectErr(await apiErrorOf(restore(f, f.P, v1.draftId, 2, 3)), 404, "version_not_found")
    expectErr(await apiErrorOf(restore(f, f.P, v1.draftId, 2, 99)), 404, "version_not_found")
    for (const bad of [undefined, null, 0, -1, 1.5, "1", true]) {
      expectErr(await apiErrorOf(restore(f, f.P, v1.draftId, 2, bad)), 400, "invalid_version")
    }
    for (const bad of [undefined, 0, 1.5, "2"]) {
      expectErr(await apiErrorOf(restore(f, f.P, v1.draftId, bad, 1)), 400, "invalid_version")
    }
    expect((await draftDoc(v1.draftId))?.currentVersion).toBe(2)
  })

  it("a stale baseVersion is 409 draft_changed; a locked draft is 409 draft_locked first", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    await save(f, f.P, v1.draftId, 1, "Second", "Second body.")
    expectErr(await apiErrorOf(restore(f, f.P, v1.draftId, 1, 1)), 409, "draft_changed")
    await adminDb().collection("drafts").doc(v1.draftId).update({ locked: true })
    expectErr(await apiErrorOf(restore(f, f.P, v1.draftId, 1, 1)), 409, "draft_locked")
    expectErr(await apiErrorOf(restore(f, f.P, v1.draftId, 2, 1)), 409, "draft_locked")
    expect((await draftDoc(v1.draftId))?.currentVersion).toBe(2)
  })

  it("a stale baseVersion is checked before the fromVersion exists check", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    await save(f, f.P, v1.draftId, 1, "Second", "Second body.")
    expectErr(await apiErrorOf(restore(f, f.P, v1.draftId, 1, 99)), 409, "draft_changed")
  })

  it("two restores on the same base: exactly one succeeds", async () => {
    const f = await newFirm()
    const v1 = await create(f, f.P, { body: "Original body." })
    await save(f, f.P, v1.draftId, 1, "Second", "Second body.")
    await save(f, f.P, v1.draftId, 2, "Third", "Third body.")
    const results = await Promise.allSettled([restore(f, f.P, v1.draftId, 3, 1), restore(f, f.A, v1.draftId, 3, 2)])
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected")
    expectErr(failed!.reason as ApiError, 409, "draft_changed")
    expect((await draftDoc(v1.draftId))?.currentVersion).toBe(4)
    expect(await versionDoc(v1.draftId, 5)).toBeUndefined()
  })

  it("only the draft's own versions can be restored (the id is built from the named draft)", async () => {
    const f = await newFirm()
    const a = await create(f, f.P, { body: "Draft A body." })
    const b = await create(f, f.P, { body: "Draft B body." })
    await save(f, f.P, b.draftId, 1, "B2", "Draft B second.")
    const out = await restore(f, f.P, a.draftId, 1, 1)
    expect(out.saved).toBe(false)
    expectErr(await apiErrorOf(restore(f, f.P, a.draftId, 1, 2)), 404, "version_not_found")
  })

  it("access: an intern, a client, accounts and a non-member are refused; another firm's draft is 404", async () => {
    const f = await newFirm()
    const other = await newFirm()
    const v1 = await create(f)
    const theirs = await create(other)
    await save(f, f.P, v1.draftId, 1, "Second", "Second body.")
    expectErr(await apiErrorOf(restore(f, f.intern, v1.draftId, 2, 1)), 403, "intern_channel_denied")
    expectErr(await apiErrorOf(restore(f, f.client, v1.draftId, 2, 1)), 403, "client_denied")
    expectErr(await apiErrorOf(restore(f, f.accounts, v1.draftId, 2, 1)), 403, "accounts_register_only")
    expectErr(await apiErrorOf(restore(f, f.outsider, v1.draftId, 2, 1)), 403, "not_member")
    expectErr(await apiErrorOf(restore(f, f.P, theirs.draftId, 1, 1)), 404, "not_found")
    expectErr(await apiErrorOf(restore(f, f.P, "no-such-draft", 1, 1)), 404, "not_found")
    expect((await draftDoc(v1.draftId))?.currentVersion).toBe(2)
  })
})

describe.skipIf(!EMULATORS)("getDraft (P4-4, P4-10)", () => {
  it("returns the draft view with the current version's title and body", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    const out = await send(getApi, f, f.C, { draftId: v1.draftId })
    expect(out).toEqual({ ...v1, version: 1, title: v1.title, body: BODY })
    expect(Object.keys(out).sort()).toEqual([...Object.keys(v1), "body", "version"].sort())
    const rows = await callAudit(f.C.uid, "draft.read", v1.draftId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ firmId: f.firmId, decision: "allow" })
  })

  it("returns a requested version's title and body while the view stays the draft's current state", async () => {
    const f = await newFirm()
    const v1 = await create(f, f.P, { title: "First title", body: "First body." })
    const v2 = await save(f, f.P, v1.draftId, 1, "Second title", "Second body.")
    const old = await send(getApi, f, f.A, { draftId: v1.draftId, version: "1" })
    expect(old).toMatchObject({ ...v2.draft, version: 1, title: "First title", body: "First body." })
    expect(old.currentVersion).toBe(2)
    const cur = await send(getApi, f, f.A, { draftId: v1.draftId, version: "2" })
    expect(cur).toMatchObject({ version: 2, title: "Second title", body: "Second body." })
  })

  it("an unknown version is 404 version_not_found; a malformed one is 400 invalid_version", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    expectErr(await apiErrorOf(send(getApi, f, f.P, { draftId: v1.draftId, version: "2" })), 404, "version_not_found")
    expectErr(await apiErrorOf(send(getApi, f, f.P, { draftId: v1.draftId, version: "99" })), 404, "version_not_found")
    for (const bad of ["0", "-1", "1.5", "abc", "", "01", "1e3", "99999999999"]) {
      expectErr(await apiErrorOf(send(getApi, f, f.P, { draftId: v1.draftId, version: bad })), 400, "invalid_version")
    }
  })

  it("returns the stored text exactly, including a body at the byte cap", async () => {
    const f = await newFirm()
    const big = "\u0627".repeat(450_000)
    const v1 = await create(f, f.P, { body: big })
    const out = await send(getApi, f, f.P, { draftId: v1.draftId })
    expect(out.body).toBe(big)
    expect(sha(out.body)).toBe(out.currentBodySha256)
  }, 60_000)

  it("shows the lock, the approval fields and the gate summary the server holds", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    const gatedAt = Timestamp.fromMillis(Date.parse("2026-10-11T10:00:00.000Z"))
    await adminDb().collection("drafts").doc(v1.draftId).update({
      locked: true,
      status: "approved",
      approvedBy: f.P.uid,
      approvedAt: gatedAt,
      approvedVersion: 1,
      gateResult: { version: 1, bodySha256: v1.currentBodySha256, status: "OK", gatedAt, overridden: false },
    })
    const out = await send(getApi, f, f.P, { draftId: v1.draftId })
    expect(out).toMatchObject({
      locked: true,
      status: "approved",
      approvedBy: f.P.uid,
      approvedAt: "2026-10-11T10:00:00.000Z",
      approvedVersion: 1,
      gateResult: { version: 1, bodySha256: v1.currentBodySha256, status: "OK", gatedAt: "2026-10-11T10:00:00.000Z", overridden: false },
    })
  })

  it("access: partner, associate and clerk members read; an intern, a client, accounts and a non-member are refused", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    for (const m of [f.P, f.A, f.C]) expect(await send(getApi, f, m, { draftId: v1.draftId })).toMatchObject({ draftId: v1.draftId })
    expectErr(await apiErrorOf(send(getApi, f, f.intern, { draftId: v1.draftId })), 403, "intern_channel_denied")
    expectErr(await apiErrorOf(send(getApi, f, f.client, { draftId: v1.draftId })), 403, "client_denied")
    expectErr(await apiErrorOf(send(getApi, f, f.accounts, { draftId: v1.draftId })), 403, "accounts_register_only")
    expectErr(await apiErrorOf(send(getApi, f, f.outsider, { draftId: v1.draftId })), 403, "not_member")
  })

  it("a missing draft, a malformed id and another firm's draft are 404 not_found; no draftId is 400; a draft above the clearance is 404", async () => {
    const f = await newFirm()
    const other = await newFirm()
    const theirs = await create(other)
    expectErr(await apiErrorOf(send(getApi, f, f.P, { draftId: "no-such-draft" })), 404, "not_found")
    expectErr(await apiErrorOf(send(getApi, f, f.P, { draftId: "a/b" })), 404, "not_found")
    expectErr(await apiErrorOf(send(getApi, f, f.P, { draftId: theirs.draftId })), 404, "not_found")
    expectErr(await apiErrorOf(send(getApi, f, f.P, {})), 400, "invalid_query")
    const secret = await create(f, f.P, { classification: "privileged" })
    const low = await memberOf(f, "associate", "confidential")
    expectErr(await apiErrorOf(send(getApi, f, low, { draftId: secret.draftId })), 404, "not_found")
  })

  it("the body of another firm's draft never reaches the answer", async () => {
    const f = await newFirm()
    const other = await newFirm()
    const theirs = await create(other, other.P, { body: "OTHER-FIRM-SECRET-BODY" })
    const err = await apiErrorOf(send(getApi, f, f.P, { draftId: theirs.draftId }))
    expect(JSON.stringify(err)).not.toContain("OTHER-FIRM-SECRET-BODY")
    expect(JSON.stringify(err)).not.toContain(other.firmId)
  })
})

describe.skipIf(!EMULATORS)("listDrafts (P4-4, P4-10)", () => {
  it("requires a matterId: missing, empty and not-a-string are 400 matter_required", async () => {
    const f = await newFirm()
    expectErr(await apiErrorOf(send(listApi, f, f.P, {})), 400, "matter_required")
    expectErr(await apiErrorOf(send(listApi, f, f.P, { matterId: "" })), 400, "matter_required")
  })

  it("lists the matter's drafts newest first by updatedAt then id, metadata only (no body)", async () => {
    const f = await newFirm()
    const made: View[] = []
    for (const title of ["First", "Second", "Third", "Fourth"]) {
      made.push(await create(f, f.P, { title, body: `Body of ${title}.` }))
      await sleep(15)
    }
    const page = await send(listApi, f, f.C, { matterId: f.matterId })
    expect(page.nextCursor).toBeNull()
    expect(page.items.map((d) => d.title)).toEqual(["Fourth", "Third", "Second", "First"])
    expect(page.items.map((d) => d.draftId)).toEqual([...made].reverse().map((d) => d.draftId))
    for (const item of page.items) {
      expect(item).not.toHaveProperty("body")
      expect(Object.keys(item).sort()).toEqual(Object.keys(made[0]!).sort())
    }
  })

  it("is audited as an allow under draft.read on the matter", async () => {
    const f = await newFirm()
    await create(f)
    await send(listApi, f, f.C, { matterId: f.matterId })
    const rows = (await adminDb().collection("audit_log").where("actorId", "==", f.C.uid).where("action", "==", "draft.read").where("target", "==", `matters/${f.matterId}`).get()).docs.map((d) => d.data())
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.decision === "allow" && r.firmId === f.firmId)).toBe(true)
  })

  it("a save moves the draft to the top; ties on updatedAt break by id descending", async () => {
    const f = await newFirm()
    const a = await create(f, f.P, { title: "A" })
    await sleep(15)
    const b = await create(f, f.P, { title: "B" })
    await sleep(15)
    await save(f, f.P, a.draftId, 1, "A edited", "A body edited.")
    expect((await send(listApi, f, f.P, { matterId: f.matterId })).items.map((d) => d.draftId)).toEqual([a.draftId, b.draftId])

    // equal updatedAt: the id decides
    const stamp = Timestamp.fromMillis(Date.parse("2026-10-11T09:00:00.000Z"))
    const ids = [a.draftId, b.draftId]
    for (const id of ids) await adminDb().collection("drafts").doc(id).update({ updatedAt: stamp })
    expect((await send(listApi, f, f.P, { matterId: f.matterId })).items.map((d) => d.draftId)).toEqual([...ids].sort().reverse())
  })

  it("pages through drafts that share one updatedAt without a gap or a repeat (the id breaks the tie)", async () => {
    const f = await newFirm()
    const ids: string[] = []
    for (const title of ["Tie A", "Tie B", "Tie C"]) ids.push((await create(f, f.P, { title })).draftId)
    const stamp = Timestamp.fromMillis(Date.parse("2026-10-11T09:00:00.000Z"))
    for (const id of ids) await adminDb().collection("drafts").doc(id).update({ updatedAt: stamp })
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: Page<View> = await send(listApi, f, f.P, { matterId: f.matterId, limit: "1", ...(cursor === null ? {} : { cursor }) })
      expect(page.items).toHaveLength(1)
      seen.push(page.items[0]!.draftId)
      cursor = page.nextCursor
      pages++
    } while (cursor !== null && pages < 10)
    expect(pages).toBe(3)
    expect(new Set(seen).size).toBe(3)
    expect(seen).toEqual([...ids].sort().reverse())
    // a second timestamp tie among a larger set, at limit 2: still every draft once
    const extra = (await create(f, f.P, { title: "Tie D" })).draftId
    await adminDb().collection("drafts").doc(extra).update({ updatedAt: stamp })
    const again: string[] = []
    cursor = null
    do {
      const page: Page<View> = await send(listApi, f, f.P, { matterId: f.matterId, limit: "2", ...(cursor === null ? {} : { cursor }) })
      again.push(...page.items.map((d) => d.draftId))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(again).toEqual([...ids, extra].sort().reverse())
  })

  it("paginates with limit and cursor without gaps or repeats", async () => {
    const f = await newFirm()
    for (let n = 1; n <= 5; n++) {
      await create(f, f.P, { title: `Draft ${n}` })
      await sleep(5)
    }
    const all = (await send(listApi, f, f.P, { matterId: f.matterId })).items.map((d) => d.draftId)
    expect(all).toHaveLength(5)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: Page<View> = await send(listApi, f, f.P, { matterId: f.matterId, limit: "2", ...(cursor === null ? {} : { cursor }) })
      expect(page.items.length).toBeLessThanOrEqual(2)
      seen.push(...page.items.map((d) => d.draftId))
      cursor = page.nextCursor
      pages++
    } while (cursor !== null)
    expect(pages).toBe(3)
    expect(seen).toEqual(all)
  })

  it("a bad limit or cursor is 400", async () => {
    const f = await newFirm()
    for (const limit of ["0", "101", "x", "-1", "1.5"]) {
      expectErr(await apiErrorOf(send(listApi, f, f.P, { matterId: f.matterId, limit })), 400, "invalid_limit")
    }
    for (const cursor of ["!!!", "e30", Buffer.from(JSON.stringify({ sortKey: 5, id: "x" })).toString("base64url"), Buffer.from(JSON.stringify({ sortKey: "x.y", id: "x" })).toString("base64url")]) {
      expectErr(await apiErrorOf(send(listApi, f, f.P, { matterId: f.matterId, cursor })), 400, "invalid_cursor")
    }
    // A sort key is exactly `<seconds>.<nanos>` in decimal digits (PR #25 review): extra parts, an empty part, a sign or an exponent is refused.
    for (const sortKey of ["1.2.3", ".2", "1.", "1", "-1.0", "+1.0", "1e3.0", " 1.0", "1.0 "]) {
      const cursor = Buffer.from(JSON.stringify({ sortKey, id: "x" })).toString("base64url")
      expectErr(await apiErrorOf(send(listApi, f, f.P, { matterId: f.matterId, cursor })), 400, "invalid_cursor")
    }
  })

  it("lists only the named matter's drafts of the caller's firm, and hides drafts above the caller's clearance", async () => {
    const f = await newFirm()
    const otherMatter = await seedMatter(f.firmId, "internal")
    await addMember(f.firmId, otherMatter, f.P.uid)
    const mine = await create(f, f.P, { title: "Mine" })
    const secret = await create(f, f.P, { title: "Secret", classification: "privileged" })
    const elsewhere = await create(f, f.P, { matterId: otherMatter, title: "Elsewhere" })
    const low = await memberOf(f, "associate", "confidential")
    const lowIds = (await send(listApi, f, low, { matterId: f.matterId })).items.map((d) => d.draftId)
    expect(lowIds).toEqual([mine.draftId])
    const all = (await send(listApi, f, f.P, { matterId: f.matterId })).items.map((d) => d.draftId).sort()
    expect(all).toEqual([mine.draftId, secret.draftId].sort())
    expect((await send(listApi, f, f.P, { matterId: otherMatter })).items.map((d) => d.draftId)).toEqual([elsewhere.draftId])
  })

  it("access: an intern, a client, accounts and a non-member are refused; another firm's matter and a missing one are 404", async () => {
    const f = await newFirm()
    const other = await newFirm()
    await create(other)
    expectErr(await apiErrorOf(send(listApi, f, f.intern, { matterId: f.matterId })), 403, "intern_channel_denied")
    expectErr(await apiErrorOf(send(listApi, f, f.client, { matterId: f.matterId })), 403, "client_denied")
    expectErr(await apiErrorOf(send(listApi, f, f.accounts, { matterId: f.matterId })), 403, "accounts_register_only")
    expectErr(await apiErrorOf(send(listApi, f, f.outsider, { matterId: f.matterId })), 403, "not_member")
    const err = await apiErrorOf(send(listApi, f, f.P, { matterId: other.matterId }))
    expectErr(err, 404, "not_found")
    expectErr(await apiErrorOf(send(listApi, f, f.P, { matterId: "no-such-matter" })), 404, "not_found")
  })

  it("a partner who is not a member of the matter sees nothing (R-2: no role is exempt)", async () => {
    const f = await newFirm()
    await create(f)
    expectErr(await apiErrorOf(send(listApi, f, f.outsider, { matterId: f.matterId })), 403, "not_member")
  })
})

describe.skipIf(!EMULATORS)("listDraftVersions (P4-4, P4-10)", () => {
  it("lists the versions newest first with metadata only", async () => {
    const f = await newFirm()
    const v1 = await create(f, f.P, { body: "Body 1." })
    await save(f, f.A, v1.draftId, 1, "Title 2", "Body 2.")
    await restore(f, f.C, v1.draftId, 2, 1)
    const page = await send(versionsApi, f, f.C, { draftId: v1.draftId })
    expect(page.nextCursor).toBeNull()
    expect(page.items.map((v) => v.version)).toEqual([3, 2, 1])
    expect(page.items.map((v) => v.kind)).toEqual(["restore", "save", "create"])
    expect(page.items.map((v) => v.createdBy)).toEqual([f.C.uid, f.A.uid, f.P.uid])
    expect(page.items.map((v) => v.bodySha256)).toEqual([sha("Body 1."), sha("Body 2."), sha("Body 1.")])
    expect(page.items[0]).toEqual({ version: 3, bodySha256: sha("Body 1."), kind: "restore", restoredFrom: 1, createdBy: f.C.uid, createdAt: page.items[0]!.createdAt })
    expect(page.items[1]).not.toHaveProperty("restoredFrom")
    for (const item of page.items) {
      expect(item).not.toHaveProperty("body")
      expect(item).not.toHaveProperty("title")
      expect(new Date(item.createdAt).toISOString()).toBe(item.createdAt)
    }
    expect(Object.keys(page.items[1]!).sort()).toEqual(["bodySha256", "createdAt", "createdBy", "kind", "version"])
  })

  it("paginates with limit and cursor", async () => {
    const f = await newFirm()
    const v1 = await create(f)
    for (let n = 1; n < 5; n++) await save(f, f.P, v1.draftId, n, `Title ${n + 1}`, `Body ${n + 1}.`)
    const seen: number[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page: Page<VersionMeta> = await send(versionsApi, f, f.P, { draftId: v1.draftId, limit: "2", ...(cursor === null ? {} : { cursor }) })
      seen.push(...page.items.map((v) => v.version))
      cursor = page.nextCursor
      pages++
    } while (cursor !== null)
    expect(seen).toEqual([5, 4, 3, 2, 1])
    expect(pages).toBe(3)
    expectErr(await apiErrorOf(send(versionsApi, f, f.P, { draftId: v1.draftId, limit: "0" })), 400, "invalid_limit")
    expectErr(await apiErrorOf(send(versionsApi, f, f.P, { draftId: v1.draftId, cursor: "!!!" })), 400, "invalid_cursor")
  })

  it("lists only the named draft's versions", async () => {
    const f = await newFirm()
    const a = await create(f)
    const b = await create(f)
    await save(f, f.P, b.draftId, 1, "B2", "B body 2.")
    expect((await send(versionsApi, f, f.P, { draftId: a.draftId })).items.map((v) => v.version)).toEqual([1])
    expect((await send(versionsApi, f, f.P, { draftId: b.draftId })).items.map((v) => v.version)).toEqual([2, 1])
  })

  it("access: refused for an intern, a client, accounts and a non-member; 404 for another firm's, a missing and an above-clearance draft; 400 with no draftId", async () => {
    const f = await newFirm()
    const other = await newFirm()
    const v1 = await create(f)
    const theirs = await create(other)
    expectErr(await apiErrorOf(send(versionsApi, f, f.intern, { draftId: v1.draftId })), 403, "intern_channel_denied")
    expectErr(await apiErrorOf(send(versionsApi, f, f.client, { draftId: v1.draftId })), 403, "client_denied")
    expectErr(await apiErrorOf(send(versionsApi, f, f.accounts, { draftId: v1.draftId })), 403, "accounts_register_only")
    expectErr(await apiErrorOf(send(versionsApi, f, f.outsider, { draftId: v1.draftId })), 403, "not_member")
    expectErr(await apiErrorOf(send(versionsApi, f, f.P, { draftId: theirs.draftId })), 404, "not_found")
    expectErr(await apiErrorOf(send(versionsApi, f, f.P, { draftId: "no-such-draft" })), 404, "not_found")
    expectErr(await apiErrorOf(send(versionsApi, f, f.P, {})), 400, "invalid_query")
    const secret = await create(f, f.P, { classification: "privileged" })
    const low = await memberOf(f, "associate", "confidential")
    expectErr(await apiErrorOf(send(versionsApi, f, low, { draftId: secret.draftId })), 404, "not_found")
  })
})

describe.skipIf(!EMULATORS)("listDocumentTypes and getTypeProfile (P4-5, P4-10, E-15)", () => {
  const ids = (page: Page<TypeRow>) => page.items.map((t) => t.id)

  async function allPages(f: Firm, m: Member, query: Record<string, string>): Promise<TypeRow[]> {
    const rows: TypeRow[] = []
    let cursor: string | null = null
    do {
      const page: Page<TypeRow> = await send(typesApi, f, m, { limit: "100", ...query, ...(cursor === null ? {} : { cursor }) })
      rows.push(...page.items)
      cursor = page.nextCursor
    } while (cursor !== null)
    return rows
  }

  it("lists the verified types sorted by id, 20 to a page by default, summary rows only", async () => {
    const f = await newFirm()
    const page = await send(typesApi, f, f.A, {})
    const expected = listDocumentTypes({}).map((t) => t.id)
    expect(ids(page)).toEqual(expected.slice(0, 20))
    expect(page.nextCursor).not.toBeNull()
    const first = getDocumentType(expected[0]!)!
    expect(page.items[0]).toEqual({ id: first.id, name: first.name, category: first.category, posture: first.posture, courtIds: [...first.courtIds] })
    expect(page.items[0]).not.toHaveProperty("checklist")
    expect(page.items[0]).not.toHaveProperty("templateId")
    const rows = await adminDb().collection("audit_log").where("actorId", "==", f.A.uid).where("action", "==", "doctype.read").get()
    expect(rows.docs.length).toBeGreaterThan(0)
    expect(rows.docs.every((d) => d.data().decision === "allow" || d.data().decision === "deny")).toBe(true)
  })

  it("pages through every verified type exactly once", async () => {
    const f = await newFirm()
    const rows = await allPages(f, f.P, {})
    expect(rows.map((t) => t.id)).toEqual(listDocumentTypes({}).map((t) => t.id))
    expect(rows).toHaveLength(159)
    const small: string[] = []
    let cursor: string | null = null
    do {
      const page: Page<TypeRow> = await send(typesApi, f, f.P, { limit: "50", ...(cursor === null ? {} : { cursor }) })
      small.push(...ids(page))
      cursor = page.nextCursor
    } while (cursor !== null)
    expect(small).toEqual(listDocumentTypes({}).map((t) => t.id))
  })

  it("filters by category, court (NON_FORUM and families included) and a part of the name, alone and together", async () => {
    const f = await newFirm()
    expect((await allPages(f, f.P, { category: "notices" })).map((t) => t.id)).toEqual(listDocumentTypes({ category: "notices" }).map((t) => t.id))
    expect((await allPages(f, f.P, { courtId: "SHC" })).map((t) => t.id)).toEqual(listDocumentTypes({ courtId: "SHC" }).map((t) => t.id))
    expect((await allPages(f, f.P, { courtId: "DSJ_KHI_EAST" })).map((t) => t.id)).toEqual(listDocumentTypes({ courtId: "DSJ_KHI_EAST" }).map((t) => t.id))
    expect((await allPages(f, f.P, { courtId: "DSJ_KHI_EAST" })).map((t) => t.id)).toContain(FAMILY_TYPE)
    expect((await allPages(f, f.P, { courtId: "MADE_UP_COURT" })).map((t) => t.id)).toContain(NON_FORUM_TYPE)
    expect((await allPages(f, f.P, { q: "BAIL" })).map((t) => t.id)).toEqual(listDocumentTypes({ q: "bail" }).map((t) => t.id))
    const both = await allPages(f, f.P, { category: "criminal", courtId: "SHC", q: "bail" })
    expect(both.map((t) => t.id)).toEqual(listDocumentTypes({ category: "criminal", courtId: "SHC", q: "bail" }).map((t) => t.id))
    expect(both.length).toBeGreaterThan(0)
    expect(await allPages(f, f.P, { category: "no_such_category" })).toEqual([])
  })

  it("a bad limit or cursor is 400; an over-long filter is 400 invalid_query", async () => {
    const f = await newFirm()
    expectErr(await apiErrorOf(send(typesApi, f, f.P, { limit: "0" })), 400, "invalid_limit")
    expectErr(await apiErrorOf(send(typesApi, f, f.P, { limit: "101" })), 400, "invalid_limit")
    expectErr(await apiErrorOf(send(typesApi, f, f.P, { cursor: "!!!" })), 400, "invalid_cursor")
    expectErr(await apiErrorOf(send(typesApi, f, f.P, { q: "x".repeat(201) })), 400, "invalid_query")
    expectErr(await apiErrorOf(send(typesApi, f, f.P, { category: "x".repeat(101) })), 400, "invalid_query")
  })

  it("getTypeProfile returns the whole seed row", async () => {
    const f = await newFirm()
    const profile = await send(profileApi, f, f.C, { typeId: TYPE })
    // The whole seed row, unchanged, plus what an approval needs (F06): the review checklist and whether it is required.
    expect(profile).toEqual({
      ...JSON.parse(JSON.stringify(getDocumentType(TYPE))),
      reviewChecklistItems: reviewChecklistOf(getDocumentType(TYPE)!),
      lawDependent: true,
    })
    expect(profile).toMatchObject({ id: TYPE, name: "Constitutional Petition (Art. 199)", templateId: "template_cp_199_v1", status: "VERIFIED" })
    expect(Array.isArray(profile.checklist)).toBe(true)
    expect(Array.isArray(profile.requiredFields)).toBe(true)
  })

  it("getTypeProfile: an unknown type is 404 document_type_not_found, a missing or non-string typeId is 400 invalid_document_type", async () => {
    const f = await newFirm()
    expectErr(await apiErrorOf(send(profileApi, f, f.P, { typeId: "no_such_type" })), 404, "document_type_not_found")
    expectErr(await apiErrorOf(send(profileApi, f, f.P, { typeId: "constructor" })), 404, "document_type_not_found")
    expectErr(await apiErrorOf(send(profileApi, f, f.P, { typeId: "__proto__" })), 404, "document_type_not_found")
    expectErr(await apiErrorOf(send(profileApi, f, f.P, {})), 400, "invalid_document_type")
    expectErr(await apiErrorOf(send(profileApi, f, f.P, { typeId: "" })), 400, "invalid_document_type")
  })

  it("doctype.read is firm-level: partner, associate and clerk read; an intern, a client and accounts are refused (a non-member partner is fine)", async () => {
    const f = await newFirm()
    for (const m of [f.P, f.A, f.C, f.outsider]) {
      expect(ids(await send(typesApi, f, m, { limit: "1" }))).toHaveLength(1)
      expect(await send(profileApi, f, m, { typeId: TYPE })).toMatchObject({ id: TYPE })
    }
    for (const call of [typesApi, profileApi] as const) {
      const data = call === typesApi ? {} : { typeId: TYPE }
      expectErr(await apiErrorOf(send(call, f, f.intern, data)), 403, "intern_channel_denied")
      expectErr(await apiErrorOf(send(call, f, f.client, data)), 403, "client_denied")
      expectErr(await apiErrorOf(send(call, f, f.accounts, data)), 403, "accounts_register_only")
    }
  })

  it("another firm's header is refused before any data (the firm comes from the header, never the body)", async () => {
    const f = await newFirm()
    const other = await newFirm()
    const err = await apiErrorOf(typesApi({ token: f.P.token, data: { firmId: other.firmId } } as never))
    expect(err.status).toBeGreaterThanOrEqual(400)
    expect(err.status).toBeLessThan(500)
  })
})
