import { FieldPath, Timestamp, type DocumentData } from "firebase-admin/firestore"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../src/admin"
import { autosaveDraft, restorePoint } from "../src/d4/autosave"
import { createDraftOp, type DraftView } from "../src/d4/drafts"
import { HttpError } from "../src/http/errors"
import type { Caller } from "../src/p5/auth"
import { CallAudit, runAudited } from "../src/p5/common"
import { EMULATORS, uniq } from "./emu"

/**
 * TEST-274-003. loadDraftForCaller is the read before the transaction. These tests make that read
 * pass, then require the write itself to refuse. A membership delete done before the call does not
 * pin this, because the load step refuses first.
 *
 * skipMembership: the load returns the draft for a caller who is not a member. The transaction's
 * requireStillPermitted must then answer 404 not_found (the not_member mapping). That dies if the
 * in-transaction call is removed, and it dies if the 403 is left unmapped.
 *
 * afterLoad: the load returns the draft while it is still editable, then the row is approved
 * before storeVersion's transaction. The guard passed into storeVersion must refuse. A lock is
 * not this pin: storeVersion also refuses a lock in refuseStaleEdit, so that refusal survives
 * with the guard omitted. The check on the load snapshot does not see the approval.
 */

const harness = vi.hoisted(() => ({
  skipMembership: false,
  afterLoad: null as null | "approve",
}))

vi.mock("../src/d4/drafts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/d4/drafts")>()
  return {
    ...real,
    loadDraftForCaller: async (caller: Caller, draftId: string, action: Parameters<typeof real.loadDraftForCaller>[2]) => {
      if (harness.skipMembership) {
        const { adminDb: db } = await import("../src/admin")
        const { HttpError: Missing } = await import("../src/http/errors")
        const ref = db().collection("drafts").doc(draftId)
        const draft = (await ref.get()).data()
        if (!draft || draft.firmId !== caller.firmId || typeof draft.matterId !== "string") throw new Missing(404, "not_found")
        return { ref, draft }
      }
      const loaded = await real.loadDraftForCaller(caller, draftId, action)
      if (harness.afterLoad === "approve") await loaded.ref.update({ status: "approved" })
      return loaded
    },
  }
})

const FLAG = "SIKANDER_FLAG_D4_AUTOSAVE"
const TYPE = "constitutional_petition_199"
const TITLE = "Petition against the impugned order"
const BODY = "IN THE HIGH COURT. The petitioner submits as follows."

const savedFlag = process.env[FLAG]
afterEach(() => {
  harness.skipMembership = false
  harness.afterLoad = null
  if (savedFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = savedFlag
})

function caller(firmId: string, role: Caller["role"], clearanceLevel: Classification = "privileged-restricted"): Caller {
  return { uid: uniq("user"), firmId, role, clearanceLevel }
}

async function audited<T>(who: Caller, action: string, run: (audit: CallAudit) => Promise<T>): Promise<T> {
  const audit = new CallAudit(action, who.uid, "drafts")
  return runAudited(audit, () => run(audit))
}

async function newMatter(): Promise<{ firmId: string; matterId: string; partner: Caller }> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal" })
  const matterId = uniq("matter")
  await adminDb()
    .collection("matters")
    .doc(matterId)
    .set({ firmId, classification: "internal", title: "Recovery suit", stage: "pre_filing", status: "open", courtId: "SHC", createdAt: Timestamp.now() })
  const partner = caller(firmId, "partner")
  await adminDb().collection("matter_members").doc(`${matterId}_${partner.uid}`).set({ firmId, matterId, userId: partner.uid, classification: "internal" })
  return { firmId, matterId, partner }
}

async function createDraft(who: Caller, matterId: string): Promise<DraftView> {
  return audited(who, "draft.create", (audit) =>
    createDraftOp.run({ caller: who, secondFactor: true }, { matterId, documentTypeId: TYPE, title: TITLE, body: BODY }, audit)
  )
}

const pointsOf = async (draftId: string): Promise<DocumentData[]> => {
  const prefix = `${draftId}_`
  const snap = await adminDb()
    .collection("draft_autosave_points")
    .where(FieldPath.documentId(), ">=", prefix)
    .where(FieldPath.documentId(), "<", `${prefix}\uf8ff`)
    .get()
  return snap.docs.map((d) => d.data())
}

async function refusal(run: Promise<unknown>): Promise<HttpError> {
  try {
    await run
  } catch (err) {
    return err as HttpError
  }
  throw new Error("expected a refusal")
}

function expectErr(err: unknown, status: number, code: string): void {
  expect(err).toBeInstanceOf(HttpError)
  const http = err as HttpError
  expect({ status: http.status, code: http.code }).toEqual({ status, code })
}

describe.skipIf(!EMULATORS)("autosave in-transaction re-check", () => {
  it("when loadDraftForCaller has already passed, the transaction's requireStillPermitted answers 404 not_found for a non-member and writes no point", async () => {
    process.env[FLAG] = "true"
    const { firmId, matterId, partner } = await newMatter()
    const draft = await createDraft(partner, matterId)
    expect((await audited(partner, "draft.edit", (audit) => autosaveDraft(partner, audit, draft.draftId, "first point", 1, 1))).written).toBe(true)

    const outsider = caller(firmId, "partner")
    harness.skipMembership = true
    const err = await refusal(audited(outsider, "draft.edit", (audit) => autosaveDraft(outsider, audit, draft.draftId, "must not land", 2, 1)))
    expectErr(err, 404, "not_found")
    const points = await pointsOf(draft.draftId)
    expect(points).toHaveLength(1)
    expect(points.some((row) => row.body === "must not land")).toBe(false)
  })

  it("storeVersion's guard refuses a draft approved after loadDraftForCaller returns and writes no version", async () => {
    process.env[FLAG] = "true"
    const { matterId, partner } = await newMatter()
    const draft = await createDraft(partner, matterId)
    expect((await audited(partner, "draft.edit", (audit) => autosaveDraft(partner, audit, draft.draftId, "kept point", 1, 1))).written).toBe(true)

    harness.afterLoad = "approve"
    const err = await refusal(audited(partner, "draft.edit", (audit) => restorePoint(partner, audit, draft.draftId, 1)))
    expectErr(err, 409, "draft_approved")
    expect(await adminDb().collection("draft_versions").doc(`${draft.draftId}_2`).get()).toMatchObject({ exists: false })
    expect((await pointsOf(draft.draftId))[0].referencedByRestore).toBe(false)
    expect((await adminDb().collection("drafts").doc(draft.draftId).get()).data()?.currentVersion).toBe(1)
  })
})
