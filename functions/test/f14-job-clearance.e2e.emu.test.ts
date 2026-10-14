import { readFileSync } from "node:fs"
import path from "node:path"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { doc, getDoc, setLogLevel, updateDoc } from "firebase/firestore"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { adminApp, adminDb } from "../src/admin"
import { jobRuntime } from "../src/p2/dispatch"
import type { DiagnosticPayload } from "../src/p2/diagnostic"
import type { JobView } from "../src/p2/view"
import { apiErrorOf, viaApi, type ApiError } from "./api"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { FakeClock, diagSpec, enqueueAt, readJob, testDeps } from "./jobs"

/**
 * Audit finding F14 (HIGH, 2026-10-13): "Job reads omit the matter's current clearance floor". End to end, through the
 * HTTP router, with real ID tokens from the Auth emulator and every row read back from the Firestore emulator.
 *
 * The user flow: a partner opens a matter at `internal` through the D1 routes (client, conflict check, openMatter) and
 * lists the team as members. The job engine enqueues work on that matter at the matter's label, with a reference to a
 * matter document; one job is dead-lettered by the worker. Then the matter is raised to `privileged-restricted`. No
 * Functions route reclassifies a matter, so the raise is an Admin SDK write, as the audit's own probe made it.
 *
 * Before the fix the job routes judged a job by the label it was stored with: a clerk cleared only to `confidential`,
 * who is now refused `job.read` on the matter, still read the job and its document reference through getJob; a
 * confidential partner listed it on the firm queue and cancelled it; a confidential associate requeued it. After the
 * fix every job route judges a matter job by its effective label, the stricter of its own label and its matter's label
 * read now, with the caller's membership read now: a caller below it gets 404 not_found on a single job, finds no row
 * in a list, and is refused retry and cancel with nothing written. A member cleared for the raised label still sees and
 * acts on the job, and every view shows the effective label. Fixtures are synthetic (P4-13): no real party or matter.
 *
 * The download door (audit §10: "repeat get/list/download as lower-clearance user"; open item O-76): the job's input
 * reference names a matter document, which a member reads through the client SDK under firestore.rules. After the raise
 * that document and its version are refused to a member below the matter's new label and still readable by one
 * cleared for it, as the job is. The document rows are written in the Next writer's shape (that writer is the Next
 * documents route, which this suite cannot drive); the raise (by the cleared partner, a monotonic matter update the
 * rules allow a member partner) and the reads go through the client SDK against the same emulator.
 */

type Member = { uid: string; token: string; role: string; clearanceLevel: string }
type Page = { items: JobView[]; nextCursor: string | null }
type Matter = { matterId: string; classification: string }

const clock = new FakeClock(Date.now())
const atClock = { now: () => clock.now() }
const registerClient = viaApi<{ clientId: string }>("registerClient", atClock)
const runCheck = viaApi<{ checkId: string; result: string }>("runConflictCheck", atClock)
const openMatter = viaApi<Matter>("openMatter", atClock)
const getMatter = viaApi<Matter>("getMatter", atClock)
const getApi = viaApi<JobView>("getJob", atClock)
const listApi = viaApi<Page>("listJobs", atClock)
const retryApi = viaApi<JobView>("retryFailedJob", atClock)
const cancelApi = viaApi<JobView>("cancelJob", atClock)

const RETRY_NOTE = "Requeued after the upstream fix landed."
const CANCEL_NOTE = "Cancelled: superseded by a newer request."

type Firm = {
  firmId: string
  matterId: string
  /** The partner who opened the matter: a member cleared privileged-restricted. */
  top: Member
  /** Members cleared only to confidential, one per role the job routes allow. */
  clerk: Member
  partner: Member
  associate: Member
  /** A partner cleared confidential who is not a member (the firm queue's restricted view). */
  outsider: Member
}

const send = <T>(api: (c: never) => Promise<T>, f: Firm, who: Member, data: Record<string, unknown>): Promise<T> =>
  api({ token: who.token, data: { firmId: f.firmId, ...data } } as never)
const getJob = (f: Firm, who: Member, jobId: string) => send(getApi, f, who, { jobId })
const listJobs = (f: Firm, who: Member, query: Record<string, unknown> = {}) => send(listApi, f, who, query)
const retryJob = (f: Firm, who: Member, jobId: string) => send(retryApi, f, who, { jobId, note: RETRY_NOTE })
const cancelJob = (f: Firm, who: Member, jobId: string) => send(cancelApi, f, who, { jobId, note: CANCEL_NOTE })

function expectErr(err: ApiError, status: number, code: string): void {
  expect({ status: err.status, code: err.code }).toEqual({ status, code })
}

const ids = (page: Page) => page.items.map((v) => v.jobId)

/** A firm whose partner opens an `internal` matter through the D1 routes, with the team listed as members. */
async function openFirm(): Promise<Firm> {
  const firmId = uniq("f14-firm")
  await adminDb()
    .collection("firms")
    .doc(firmId)
    .set({ name: "F14 Firm", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS", rateLimits: { general: 1000 } })
  const user = async (role: string, clearanceLevel: string): Promise<Member> => {
    const { uid, token } = await mintIdToken({ firmId, role, clearanceLevel })
    return { uid, token, role, clearanceLevel }
  }
  const top = await user("partner", "privileged-restricted")
  const clerk = await user("clerk", "confidential")
  const partner = await user("partner", "confidential")
  const associate = await user("associate", "confidential")
  const outsider = await user("partner", "confidential")

  const anon = { firmId, matterId: "", top, clerk, partner, associate, outsider }
  const client = await send(registerClient, anon, top, { name: "Test Client 2099", type: "individual", primaryMobile: "03013000001", classification: "internal" })
  const check = await send(runCheck, anon, top, { client: { clientId: client.clientId }, opposingParties: [{ name: "Test Respondent 2099" }] })
  expect(check.result).toBe("CLEAR")
  const matter = await send(openMatter, anon, top, {
    conflictCheckId: check.checkId,
    title: "Synthetic recovery suit",
    classification: "internal",
    memberUserIds: [clerk.uid, partner.uid, associate.uid],
  })
  expect(matter.classification).toBe("internal")
  return { ...anon, matterId: matter.matterId }
}

/** A diagnostic job on the matter, at the matter's label, citing one of its documents, enqueued now by the engine. */
async function enqueueOnMatter(f: Firm, docRef: string, payload: DiagnosticPayload): Promise<string> {
  const spec = diagSpec(f.firmId, payload, { matterId: f.matterId, classification: "internal", inputRefs: [docRef], createdBy: f.top.uid })
  return (await enqueueAt(spec, clock.now())).jobId
}

describe.skipIf(!EMULATORS)("F14: job routes apply the matter's current label and membership (end to end through the HTTP routes)", () => {
  let deps: ReturnType<typeof testDeps>

  beforeEach(() => {
    clock.set(Date.now())
    deps = testDeps(clock)
    jobRuntime.deps = deps
  })
  afterEach(() => {
    delete jobRuntime.deps
  })

  it("after the matter is raised above a caller's clearance, getJob is 404, listJobs shows no row, and retry and cancel are refused with nothing written", async () => {
    const f = await openFirm()
    const docRef = `documents/${uniq("f14-plaint")}`
    const queued = await enqueueOnMatter(f, docRef, { behaviour: "succeed" })
    const dead = await enqueueOnMatter(f, `documents/${uniq("f14-annex")}`, { behaviour: "permanent" })
    // The worker runs the second job: a permanent failure dead-letters it at once.
    expect(await deps.dispatcher.deliver({ jobId: dead, seq: 0 }, clock.now())).toBe("dead_lettered")
    expect((await readJob(dead)).status).toBe("dead_lettered")

    // Before the raise: the confidential clerk is a member cleared for the internal job and reads it in full.
    const before = await getJob(f, f.clerk, queued)
    expect(before).toMatchObject({ jobId: queued, matterId: f.matterId, classification: "internal", inputRefs: [docRef] })
    expect(ids(await listJobs(f, f.partner))).toEqual(expect.arrayContaining([queued, dead]))

    // The matter is raised above every confidential caller's clearance.
    await adminDb().collection("matters").doc(f.matterId).update({ classification: "privileged-restricted" })
    expectErr(await apiErrorOf(send(getMatter, f, f.clerk, { matterId: f.matterId })), 403, "clearance")
    const rows = await Promise.all([readJob(queued), readJob(dead)])

    // 1. getJob: 404 not_found for every caller below the matter's label, member or not, whatever the role.
    for (const who of [f.clerk, f.partner, f.associate, f.outsider]) {
      for (const jobId of [queued, dead]) expectErr(await apiErrorOf(getJob(f, who, jobId)), 404, "not_found")
    }

    // 2. listJobs: no row. Naming the matter is refused by the matter gate; the firm queue leaves the rows out,
    //    for a member partner (full rows before the fix) and a non-member partner (restricted rows before the fix).
    expectErr(await apiErrorOf(listJobs(f, f.clerk, { matterId: f.matterId })), 403, "clearance")
    expectErr(await apiErrorOf(listJobs(f, f.partner, { matterId: f.matterId })), 403, "clearance")
    expectErr(await apiErrorOf(listJobs(f, f.clerk)), 403, "role_not_permitted")
    for (const who of [f.partner, f.outsider]) {
      const queue = await listJobs(f, who)
      expect(ids(queue)).not.toContain(queued)
      expect(ids(queue)).not.toContain(dead)
      expect(queue.nextCursor).toBeNull()
      expect(JSON.stringify(queue)).not.toContain(docRef)
    }
    for (const status of ["queued", "dead_lettered"]) expect(ids(await listJobs(f, f.partner, { status }))).toEqual([])

    // 3. retryFailedJob and cancelJob: the confidential associate may retry and the confidential partner may cancel by
    //    role, yet both are refused as for a job they cannot see; the clerk's role is refused first. Nothing is written.
    expectErr(await apiErrorOf(retryJob(f, f.associate, dead)), 404, "not_found")
    expectErr(await apiErrorOf(retryJob(f, f.partner, dead)), 404, "not_found")
    expectErr(await apiErrorOf(retryJob(f, f.clerk, dead)), 403, "role_not_permitted")
    for (const jobId of [queued, dead]) expectErr(await apiErrorOf(cancelJob(f, f.partner, jobId)), 404, "not_found")
    expectErr(await apiErrorOf(cancelJob(f, f.outsider, queued)), 404, "not_found")
    expectErr(await apiErrorOf(cancelJob(f, f.clerk, queued)), 403, "role_not_permitted")
    const after = await Promise.all([readJob(queued), readJob(dead)])
    for (const [i, row] of after.entries()) expect(row.updateTime.isEqual(rows[i].updateTime)).toBe(true)
    expect(after.map((r) => r.status)).toEqual(["queued", "dead_lettered"])
    expect(deps.dispatcher.tasks.filter((t) => t.jobId === dead && t.seq > 0)).toEqual([])

    // 4. A member cleared for the raised label still reads, lists, retries and cancels, and sees the effective label.
    expect(await getJob(f, f.top, queued)).toMatchObject({ jobId: queued, matterId: f.matterId, classification: "privileged-restricted", inputRefs: [docRef] })
    const queue = await listJobs(f, f.top)
    const listed = queue.items.filter((v) => v.jobId === queued || v.jobId === dead)
    expect(listed.map((v) => [v.jobId, v.classification]).sort()).toEqual([[dead, "privileged-restricted"], [queued, "privileged-restricted"]].sort())
    const matterList = await listJobs(f, f.top, { matterId: f.matterId })
    expect(matterList.items.map((v) => v.classification)).toEqual(["privileged-restricted", "privileged-restricted"])
    expect(await retryJob(f, f.top, dead)).toMatchObject({ jobId: dead, status: "queued", manualRetries: 1, classification: "privileged-restricted" })
    expect(await cancelJob(f, f.top, queued)).toMatchObject({ jobId: queued, status: "cancelled", classification: "privileged-restricted" })
    expect((await readJob(queued)).cancellation).toMatchObject({ by: f.top.uid, note: CANCEL_NOTE })
    expect((await readJob(dead)).requeues).toEqual([expect.objectContaining({ by: f.top.uid, note: RETRY_NOTE })])
  })

  it("a member removed from the matter loses the job at once, and a firm-level job keeps its partner-only rule", async () => {
    const f = await openFirm()
    const docRef = `documents/${uniq("f14-brief")}`
    const onMatter = await enqueueOnMatter(f, docRef, { behaviour: "succeed" })
    const firmLevel = (await enqueueAt(diagSpec(f.firmId, { behaviour: "succeed" }, { createdBy: f.top.uid }), clock.now())).jobId
    expect((await getJob(f, f.associate, onMatter)).inputRefs).toEqual([docRef])

    // Membership is read on every call: the removed associate and clerk no longer see the job.
    for (const who of [f.associate, f.clerk]) await adminDb().collection("matter_members").doc(`${f.matterId}_${who.uid}`).delete()
    for (const who of [f.associate, f.clerk]) expectErr(await apiErrorOf(getJob(f, who, onMatter)), 404, "not_found")

    // A firm-level job (no matter): unchanged by F14. Any partner cleared for its label reads it; others do not.
    for (const who of [f.top, f.partner, f.outsider]) expect(await getJob(f, who, firmLevel)).toMatchObject({ jobId: firmLevel, matterId: null, classification: "internal" })
    for (const who of [f.associate, f.clerk]) expectErr(await apiErrorOf(getJob(f, who, firmLevel)), 404, "not_found")
    expect(ids(await listJobs(f, f.partner))).toContain(firmLevel)

    // Raising the matter leaves the firm-level job alone and hides only the matter job from the confidential partner.
    await adminDb().collection("matters").doc(f.matterId).update({ classification: "privileged" })
    const queue = ids(await listJobs(f, f.partner))
    expect(queue).toContain(firmLevel)
    expect(queue).not.toContain(onMatter)
    expect((await getJob(f, f.top, onMatter)).classification).toBe("privileged")
  })

  describe("the download door: the job's input document through the client SDK (firestore.rules)", () => {
    let env: RulesTestEnvironment

    beforeAll(async () => {
      setLogLevel("silent")
      const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":")
      // The project the Admin SDK writes to, so the rules read the rows the job routes read.
      const projectId = adminApp().options.projectId ?? process.env.GCLOUD_PROJECT
      if (!projectId) throw new Error("no emulator project id (GCLOUD_PROJECT)")
      env = await initializeTestEnvironment({
        projectId,
        firestore: { rules: readFileSync(path.resolve(__dirname, "../../firestore.rules"), "utf8"), host, port: Number(port) },
      })
    })
    afterAll(async () => {
      await env?.cleanup()
    })

    /** The member's signed-in client SDK, with the token claims its users/{uid} record holds. */
    const clientDb = (f: Firm, who: Member) =>
      env.authenticatedContext(who.uid, { firmId: f.firmId, role: who.role, clearanceLevel: who.clearanceLevel }).firestore()

    it("after the raise, the job's input document and its version are refused to a member below the matter's label and readable by one cleared for it", async () => {
      const f = await openFirm()
      const docId = uniq("f14-plaint")
      const versionId = `${docId}_1`
      const storagePath = `firms/${f.firmId}/documents/${docId}/v1`
      // The Next documents writer's shape (platform/spine/store.ts DocumentRecord), at the matter's label.
      await adminDb().collection("documents").doc(docId).set({
        id: docId,
        firmId: f.firmId,
        matterId: f.matterId,
        contentHash: "0".repeat(64),
        sourceChannel: "web",
        classification: "internal",
        storagePath,
        isImmutable: true,
        byteSize: 24,
        mimeType: "application/pdf",
        objectVersion: 1,
        uploadedBy: f.top.uid,
        objectBytesStatus: "available",
      })
      await adminDb().collection("document_versions").doc(versionId).set({ firmId: f.firmId, matterId: f.matterId, documentId: docId, version: 1, storagePath, createdBy: f.top.uid, classification: "internal" })
      const jobId = await enqueueOnMatter(f, `documents/${docId}`, { behaviour: "succeed" })

      // Before the raise: the clerk follows the job's reference to the document and its version.
      expect((await getJob(f, f.clerk, jobId)).inputRefs).toEqual([`documents/${docId}`])
      for (const who of [f.clerk, f.partner, f.associate, f.top]) {
        await assertSucceeds(getDoc(doc(clientDb(f, who), "documents", docId)))
        await assertSucceeds(getDoc(doc(clientDb(f, who), "document_versions", versionId)))
      }

      // The cleared partner raises the matter through the client SDK (firestore.rules: a member partner's monotonic update).
      await assertFails(updateDoc(doc(clientDb(f, f.clerk), "matters", f.matterId), { classification: "privileged-restricted" }))
      await assertSucceeds(updateDoc(doc(clientDb(f, f.top), "matters", f.matterId), { classification: "privileged-restricted" }))
      expect((await adminDb().collection("matters").doc(f.matterId).get()).get("classification")).toBe("privileged-restricted")

      // After the raise: the job is hidden, and so is what it references, from every member below the new label.
      expectErr(await apiErrorOf(getJob(f, f.clerk, jobId)), 404, "not_found")
      for (const who of [f.clerk, f.partner, f.associate]) {
        await assertFails(getDoc(doc(clientDb(f, who), "documents", docId)))
        await assertFails(getDoc(doc(clientDb(f, who), "document_versions", versionId)))
      }
      // The member cleared for the raised label reads the job, the document and its version.
      expect((await getJob(f, f.top, jobId)).inputRefs).toEqual([`documents/${docId}`])
      await assertSucceeds(getDoc(doc(clientDb(f, f.top), "documents", docId)))
      await assertSucceeds(getDoc(doc(clientDb(f, f.top), "document_versions", versionId)))
    })
  })
})
