import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { adminDb } from "../src/admin"
import { keywordIntakeClassifier } from "../src/d1/intake/classify"
import { intakeEnabled } from "../src/d1/intake/flag"
import {
  IntakeRefusal,
  classifyIntake,
  closeIntake,
  createIntake,
  getIntakeThread,
  listIntakes,
  promoteToClient,
  routeIntake,
  type IntakeClassifier,
} from "../src/d1/intake/ops"
import { routeByRules } from "../src/d1/intake/route"
import { reconcileNameIndex } from "../src/d1/conflict/nameIndex"
import type { Caller } from "../src/p5/auth"
import { classificationRank } from "@/platform/p1/types"
import { EMULATORS, mintIdToken, uniq } from "./emu"
import { viaApi } from "./api"
import { registryRecorder } from "./setup/registryWriteRecorder"

/**
 * Module 5 client intake (W1-Q09A). The HTTP router is not wired (wave 2); these tests call the
 * module against the Firestore emulator and use the existing conflict routes for the waiver path.
 */

const FLAG = "SIKANDER_FLAG_D1_INTAKE"
const resolveReview = viaApi<{ result: string; hits: Array<{ outcome: string; type: string; review?: unknown }> }>("resolveReviewItem")
const waive = viaApi<{ decision: string }>("recordPartnerWaiver")
const NOTE20 = "Same person on the role-crossing hit."
const NOTE50 = "Partner waiver: the clients are not adverse in substance, informed consent is on file."

const claims = (firmId: string, role: string, clearanceLevel = "privileged-restricted") => ({ firmId, role, clearanceLevel })

afterEach(() => {
  delete process.env[FLAG]
})

describe("intake flag, classifier and routing (no emulator)", () => {
  it("an unset, blank, or non-true flag is off; only a trimmed true is on", () => {
    delete process.env[FLAG]
    expect(intakeEnabled()).toBe(false)
    process.env[FLAG] = "yes"
    expect(intakeEnabled()).toBe(false)
    process.env[FLAG] = " TRUE "
    expect(intakeEnabled()).toBe(true)
  })

  it("classifies by keyword and never turns an ambiguous or unknown court prefix into a practice area", () => {
    const bail = keywordIntakeClassifier.classify({ text: "Urgent bail before the magistrate", prospectName: "Mr Ali", prospectType: "individual" })
    expect(bail.practiceArea).toBe("criminal")
    expect(bail.urgency).toBe("urgent")
    expect(bail.followUp).toBe(false)

    const ambiguous = keywordIntakeClassifier.classify({
      text: "C.P. No. 123 of 2024",
      prospectName: "Mr Ali",
      prospectType: "individual",
      courtRef: { raw: "C.P. No. 123 of 2024", courtId: "SC_PK" },
    })
    expect(ambiguous.followUp).toBe(true)
    expect(ambiguous.followUpReasons).toContain("ambiguous_court_prefix")
    expect(ambiguous.practiceArea).toBeNull()
    expect(ambiguous.court?.status).toBe("ambiguous")

    const unknown = keywordIntakeClassifier.classify({
      text: "ZZZ No. 1 of 2024",
      prospectName: "Mr Ali",
      prospectType: "individual",
      courtRef: { raw: "ZZZ No. 1 of 2024", courtId: "SC_PK" },
    })
    expect(unknown.followUpReasons).toContain("unknown_court_prefix")
    expect(unknown.court?.status).toBe("rejected")
    expect(unknown.practiceArea).toBeNull()

    const proto = keywordIntakeClassifier.classify({
      text: "hello",
      prospectName: "Mr Ali",
      prospectType: "individual",
      courtRef: { raw: "C.P. No. 1 of 2024", courtId: "constructor" },
    })
    expect(proto.followUpReasons).toContain("unknown_court_prefix")
    expect(proto.practiceArea).toBeNull()
  })

  it("does not guess an entity type", () => {
    const company = keywordIntakeClassifier.classify({ text: "hello", prospectName: "Sikander (Pvt) Ltd", prospectType: null })
    expect(company.prospectType).toBe("company")
    expect(company.followUp).toBe(false)
    const person = keywordIntakeClassifier.classify({ text: "hello", prospectName: "Mr Kamran Shah", prospectType: null })
    expect(person.prospectType).toBe("individual")
    const ambiguous = keywordIntakeClassifier.classify({ text: "hello", prospectName: "Sikander Holdings", prospectType: null })
    expect(ambiguous.prospectType).toBeNull()
    expect(ambiguous.followUpReasons).toContain("ambiguous_entity")
  })

  it("routes the same rules to the same assignee, and an unknown area or a follow-up to the follow-up queue", () => {
    const rules = [
      { practiceArea: "civil", assigneeId: "civil-lawyer" },
      { practiceArea: "criminal", assigneeId: "crime-lawyer" },
      { practiceArea: "criminal", assigneeId: "later-lawyer" },
    ]
    const once = routeByRules({ practiceArea: "criminal", followUp: false }, rules)
    const twice = routeByRules({ practiceArea: "criminal", followUp: false }, rules)
    expect(once).toEqual({ queue: "lawyer", assigneeId: "crime-lawyer" })
    expect(twice).toEqual(once)
    expect(routeByRules({ practiceArea: null, followUp: false }, rules)).toEqual({ queue: "follow_up", assigneeId: null })
    expect(routeByRules({ practiceArea: "criminal", followUp: true }, rules)).toEqual({ queue: "follow_up", assigneeId: null })
  })
})

async function newFirm(): Promise<string> {
  const firmId = uniq("firm")
  await adminDb().collection("firms").doc(firmId).set({ name: "F", plan: "internal", clientPrefix: "SKD", matterPrefix: "NHS" })
  return firmId
}

let mobileSeq = 4_000_000
const nextPhone = () => `0300${String(++mobileSeq)}`

async function asCaller(firmId: string, role: string, clearanceLevel = "privileged-restricted"): Promise<{ caller: Caller; token: string; uid: string }> {
  const minted = await mintIdToken(claims(firmId, role, clearanceLevel))
  const caller: Caller = { uid: minted.uid, firmId, role: role as Caller["role"], clearanceLevel: clearanceLevel as Caller["clearanceLevel"] }
  return { caller, token: minted.token, uid: minted.uid }
}

const prospect = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  phone: nextPhone(),
  type: "individual" as const,
  opposingParties: [{ name: "Haris Qalbani" }],
  ...extra,
})

async function counts(firmId: string) {
  const [clients, matters, checks] = await Promise.all([
    adminDb().collection("clients").where("firmId", "==", firmId).get(),
    adminDb().collection("matters").where("firmId", "==", firmId).get(),
    adminDb().collection("conflict_checks").where("firmId", "==", firmId).get(),
  ])
  return { clients: clients.size, matters: matters.size, checks: checks.size }
}

describe.skipIf(!EMULATORS)("client intake (emulator)", () => {
  beforeEach(() => {
    process.env[FLAG] = "true"
  })

  it("a promotion without confirmation refuses and writes nothing", async () => {
    const firmId = await newFirm()
    const { caller } = await asCaller(firmId, "partner")
    const intake = await createIntake(caller, { text: "Please file a civil suit", prospect: prospect("Unconfirmed Prospect") })
    const beforeDoc = (await adminDb().collection("intakes").doc(intake.intakeId).get()).data()
    expect(beforeDoc).toMatchObject({ firmId, matterId: null })
    const unpromoted = await adminDb().collection("intake_messages").where("intakeId", "==", intake.intakeId).get()
    expect(unpromoted.docs.map((doc) => doc.data())).toEqual([expect.objectContaining({ firmId, intakeId: intake.intakeId, matterId: null })])
    const before = await counts(firmId)
    await expect(promoteToClient(caller, intake.intakeId, {})).rejects.toMatchObject({ status: 400, code: "confirmation_required" })
    await expect(promoteToClient(caller, intake.intakeId, { confirmedBy: "not-the-caller" })).rejects.toMatchObject({ code: "confirmation_required" })
    const clerk = await asCaller(firmId, "clerk")
    await expect(promoteToClient(clerk.caller, intake.intakeId, { confirmedBy: clerk.uid })).rejects.toMatchObject({ code: "confirmation_required" })
    expect(await counts(firmId)).toEqual(before)
    expect((await adminDb().collection("intakes").doc(intake.intakeId).get()).data()).toEqual(beforeDoc)
  }, 60_000)

  it("a FLAG conflict blocks promotion until the recorded partner waiver, which the opened matter references", async () => {
    const firmId = await newFirm()
    const { caller, token, uid } = await asCaller(firmId, "partner")
    const existing = await createIntake(caller, { text: "Please file a civil suit", prospect: prospect("Bashir Ahmed") })
    const registered = await promoteToClient(caller, existing.intakeId, { confirmedBy: uid })
    const matterId = adminDb().collection("matters").doc()
    await matterId.set({
      firmId,
      clientId: registered.clientId,
      matterNo: "NHS/2026/0009",
      title: "Earlier adverse matter",
      stage: "pre_filing",
      status: "live",
      conflictCheckId: registered.conflictCheckId,
      classification: "confidential",
    })
    await adminDb().collection("matter_parties").add({
      firmId,
      matterId: matterId.id,
      role: "opposing",
      name: "Zarnab Traders",
      keys: {},
      matterClassification: "confidential",
      matterStatus: "live",
      classification: "confidential",
    })
    await reconcileNameIndex(firmId)

    const intake = await createIntake(caller, { text: "Please file a civil suit", prospect: prospect("Zarnab Traders") })
    const clientsBefore = (await adminDb().collection("clients").where("firmId", "==", firmId).where("canonicalName", "==", "Zarnab Traders").get()).size
    const blocked = await promoteToClient(caller, intake.intakeId, { confirmedBy: uid }).then(
      () => {
        throw new Error("expected the unresolved conflict to block")
      },
      (err: unknown) => err as IntakeRefusal
    )
    expect(blocked).toMatchObject({ status: 409, code: "conflict_blocked" })
    expect(blocked.conflictCheckId).toEqual(expect.any(String))
    const checkId = blocked.conflictCheckId as string
    expect((await adminDb().collection("clients").where("firmId", "==", firmId).where("canonicalName", "==", "Zarnab Traders").get()).size).toBe(clientsBefore)

    const hits = ((await adminDb().collection("conflict_checks").doc(checkId).get()).data()?.hits ?? []) as Array<{ outcome: string; type: string }>
    for (const [index, hit] of hits.entries()) {
      if (hit.outcome !== "POSSIBLE_CANDIDATE_REVIEW") continue
      const resolution = hit.type === "informational" ? "different_person" : "same_person"
      await resolveReview({ token, data: { firmId, checkId, hitIndex: index, resolution, note: NOTE20 } } as never)
    }
    const flagged = (await adminDb().collection("conflict_checks").doc(checkId).get()).data()
    expect(flagged?.result).toBe("FLAG")

    const still = await promoteToClient(caller, intake.intakeId, { confirmedBy: uid }).then(
      () => {
        throw new Error("expected the FLAG to block")
      },
      (err: unknown) => err as IntakeRefusal
    )
    expect(still).toMatchObject({ status: 409, code: "conflict_blocked", conflictCheckId: checkId })
    expect((await adminDb().collection("clients").where("firmId", "==", firmId).where("canonicalName", "==", "Zarnab Traders").get()).size).toBe(clientsBefore)
    expect((await adminDb().collection("matters").where("clientId", "==", "none").get()).size).toBe(0)

    await waive({ token, data: { firmId, checkId, note: NOTE50, clientConsent: true, consentReference: "Letter 2026-11-01" } } as never)
    const promoted = await promoteToClient(caller, intake.intakeId, { confirmedBy: uid })
    expect(promoted.conflictCheckId).toBe(checkId)
    expect(promoted.waiver).toMatchObject({ partnerId: uid, consentReference: "Letter 2026-11-01" })
    const matter = (await adminDb().collection("matters").doc(promoted.matterId).get()).data()
    expect(matter).toMatchObject({ firmId, clientId: promoted.clientId, conflictCheckId: checkId })
    const check = (await adminDb().collection("conflict_checks").doc(checkId).get()).data()
    expect(check).toMatchObject({ boundMatterId: promoted.matterId, waiver: { partnerId: uid, consentReference: "Letter 2026-11-01" } })
    expect((await adminDb().collection("clients").where("firmId", "==", firmId).where("canonicalName", "==", "Zarnab Traders").get()).size).toBe(1)
  }, 120_000)

  it("a cross-firm intake id is not found, the same as a missing id", async () => {
    const firmA = await newFirm()
    const firmB = await newFirm()
    const a = await asCaller(firmA, "partner")
    const b = await asCaller(firmB, "partner")
    const intake = await createIntake(a.caller, { text: "Please file a civil suit", prospect: prospect("Secret Prospect") })
    const missing = "missing-intake-id"
    for (const id of [intake.intakeId, missing]) {
      await expect(getIntakeThread(b.caller, id)).rejects.toMatchObject({ status: 404, code: "not_found" })
      await expect(promoteToClient(b.caller, id, { confirmedBy: b.uid })).rejects.toMatchObject({ status: 404, code: "not_found" })
      await expect(closeIntake(b.caller, id)).rejects.toMatchObject({ code: "not_found" })
      await expect(routeIntake(b.caller, id, [])).rejects.toMatchObject({ code: "not_found" })
      await expect(classifyIntake(b.caller, id)).rejects.toMatchObject({ code: "not_found" })
    }
    const listed = await listIntakes(b.caller)
    expect(listed.items.map((row) => row.intakeId)).not.toContain(intake.intakeId)
    expect(JSON.stringify(listed)).not.toContain("Secret Prospect")
    const own = await getIntakeThread(a.caller, intake.intakeId)
    expect(own.messages.map((m) => m.text)).toEqual(["Please file a civil suit"])
  }, 60_000)

  it("a double promote gives one client and one matter", async () => {
    const firmId = await newFirm()
    const { caller, uid } = await asCaller(firmId, "partner")
    const intake = await createIntake(caller, { text: "Please file a civil suit", prospect: prospect("Qasim Lodhi") })
    const first = await promoteToClient(caller, intake.intakeId, { confirmedBy: uid })
    const second = await promoteToClient(caller, intake.intakeId, { confirmedBy: uid })
    expect(second).toMatchObject({ clientId: first.clientId, matterId: first.matterId, conflictCheckId: first.conflictCheckId })
    expect((await adminDb().collection("clients").where("firmId", "==", firmId).get()).size).toBe(1)
    expect((await adminDb().collection("matters").where("firmId", "==", firmId).where("clientId", "==", first.clientId).get()).size).toBe(1)
    expect((await adminDb().collection("intakes").doc(intake.intakeId).get()).data()).toMatchObject({ firmId, matterId: first.matterId })
    const stamped = await adminDb().collection("intake_messages").where("intakeId", "==", intake.intakeId).get()
    expect(stamped.docs.map((doc) => doc.data())).toEqual([expect.objectContaining({ firmId, matterId: first.matterId })])
  }, 60_000)

  it("a closed intake cannot be promoted", async () => {
    const firmId = await newFirm()
    const { caller, uid } = await asCaller(firmId, "partner")
    const intake = await createIntake(caller, { text: "Please file a civil suit", prospect: prospect("Closed Prospect") })
    await closeIntake(caller, intake.intakeId, "The enquirer withdrew.")
    const before = await counts(firmId)
    await expect(promoteToClient(caller, intake.intakeId, { confirmedBy: uid })).rejects.toMatchObject({ status: 409, code: "intake_closed" })
    expect(await counts(firmId)).toEqual(before)
  }, 60_000)

  it("routing is deterministic, and an unknown practice area goes to the follow-up queue", async () => {
    const firmId = await newFirm()
    const partner = await asCaller(firmId, "partner")
    const other = await asCaller(firmId, "associate")
    const rules = [
      { practiceArea: "civil", assigneeId: other.uid },
      { practiceArea: "criminal", assigneeId: partner.uid },
      { practiceArea: "criminal", assigneeId: other.uid },
    ]
    const crime = await createIntake(partner.caller, { text: "Urgent bail application", prospect: prospect("Bail Applicant") })
    const first = await routeIntake(partner.caller, crime.intakeId, rules)
    const second = await routeIntake(partner.caller, crime.intakeId, rules)
    expect(first).toMatchObject({ queue: "lawyer", assigneeId: partner.uid, practiceArea: "criminal", status: "routed" })
    expect(second).toMatchObject({ queue: first.queue, assigneeId: first.assigneeId, status: first.status })

    const unknown = await createIntake(partner.caller, { text: "Please ring me back tomorrow", prospect: prospect("Unknown Area") })
    const queued = await routeIntake(partner.caller, unknown.intakeId, rules)
    const queuedAgain = await routeIntake(partner.caller, unknown.intakeId, rules)
    expect(queued.practiceArea).toBeNull()
    expect(queued).toMatchObject({ queue: "follow_up", assigneeId: null, status: "follow_up" })
    expect(queuedAgain).toMatchObject({ queue: "follow_up", assigneeId: null })
  }, 60_000)

  it("flag off refuses every op before any store read", async () => {
    const caller: Caller = { uid: "flag-off-user", firmId: "flag-off-firm", role: "partner", clearanceLevel: "privileged-restricted" }
    const calls = [
      () => createIntake(caller, { text: "bail", prospect: { name: "Mr A" } }),
      () => listIntakes(caller),
      () => getIntakeThread(caller, "nope"),
      () => classifyIntake(caller, "nope"),
      () => routeIntake(caller, "nope", []),
      () => closeIntake(caller, "nope"),
      () => promoteToClient(caller, "nope", { confirmedBy: caller.uid }),
    ]
    for (const value of [undefined, "false", "yes"] as const) {
      if (value === undefined) delete process.env[FLAG]
      else process.env[FLAG] = value
      for (const call of calls) {
        const reads = await registryRecorder.readsDuring(async () => {
          await expect(call()).rejects.toMatchObject({ status: 404, code: "feature_disabled" })
        })
        expect([...reads]).toEqual([])
      }
    }
  }, 30_000)

  it("classification never downgrades on promotion", async () => {
    const firmId = await newFirm()
    const { caller, uid } = await asCaller(firmId, "partner")
    const intake = await createIntake(caller, {
      text: "Please file a civil suit",
      classification: "privileged",
      prospect: prospect("Parveen Sultana"),
    })
    expect(intake.classification).toBe("privileged")
    const promoted = await promoteToClient(caller, intake.intakeId, { confirmedBy: uid })
    const client = (await adminDb().collection("clients").doc(promoted.clientId).get()).data()
    const matter = (await adminDb().collection("matters").doc(promoted.matterId).get()).data()
    expect(classificationRank(client?.classification)).toBeGreaterThanOrEqual(classificationRank("privileged"))
    expect(classificationRank(matter?.classification)).toBeGreaterThanOrEqual(classificationRank("privileged"))
    expect((await adminDb().collection("intakes").doc(intake.intakeId).get()).data()?.classification).toBe("privileged")
  }, 60_000)

  it("a caller cleared below the intake does not see it and cannot promote it", async () => {
    const firmId = await newFirm()
    const partner = await asCaller(firmId, "partner")
    const low = await asCaller(firmId, "associate", "internal")
    const hidden = await createIntake(partner.caller, {
      text: "Please file a civil suit",
      classification: "privileged",
      prospect: prospect("Hidden Prospect"),
    })
    const visible = await createIntake(low.caller, { text: "Please file a civil suit", prospect: prospect("Visible Prospect"), classification: "internal" })
    const reads = await registryRecorder.readsDuring(async () => {
      await expect(getIntakeThread(low.caller, hidden.intakeId)).rejects.toMatchObject({ status: 404, code: "not_found" })
    })
    expect(reads.has("intake_messages")).toBe(false)
    await expect(promoteToClient(low.caller, hidden.intakeId, { confirmedBy: low.uid })).rejects.toMatchObject({ code: "not_found" })
    await expect(closeIntake(low.caller, hidden.intakeId)).rejects.toMatchObject({ code: "not_found" })
    const listed = await listIntakes(low.caller)
    expect(listed.items.map((row) => row.intakeId)).toEqual([visible.intakeId])
    expect(JSON.stringify(listed)).not.toContain("Hidden Prospect")
    expect((await adminDb().collection("clients").where("firmId", "==", firmId).where("canonicalName", "==", "Hidden Prospect").get()).size).toBe(0)
    const own = await getIntakeThread(partner.caller, hidden.intakeId)
    expect(own.intake.prospect.name).toBe("Hidden Prospect")
  }, 60_000)

  it("stores an ambiguous court prefix and an ambiguous entity as follow-up and does not guess", async () => {
    const firmId = await newFirm()
    const { caller } = await asCaller(firmId, "associate")
    const court = await createIntake(caller, {
      text: "C.P. No. 123 of 2024",
      prospect: { name: "Mr Ali Raza", phone: nextPhone(), type: "individual" },
      courtRef: { raw: "C.P. No. 123 of 2024", courtId: "SC_PK" },
    })
    expect(court).toMatchObject({ status: "follow_up", practiceArea: null, court: { status: "ambiguous" } })
    expect(JSON.stringify(court)).not.toMatch(/CPLA|CONSTP/)

    const entity = await createIntake(caller, {
      text: "Please call",
      prospect: { name: "Sikander Holdings", phone: nextPhone() },
    })
    expect(entity).toMatchObject({ status: "follow_up", prospect: { type: null } })
  }, 60_000)

  it("uses an injected classifier instead of the keyword rules", async () => {
    const firmId = await newFirm()
    const { caller, uid } = await asCaller(firmId, "partner")
    const intake = await createIntake(caller, { text: "Please ring me back", prospect: prospect("Injected Prospect") })
    expect(intake.practiceArea).toBeNull()
    const stub: IntakeClassifier = {
      classify: () => ({
        practiceArea: "land",
        urgency: "routine",
        followUp: false,
        followUpReasons: [],
        prospectType: "individual",
        court: null,
      }),
    }
    const classified = await classifyIntake(caller, intake.intakeId, stub)
    expect(classified.practiceArea).toBe("land")
    const routed = await routeIntake(caller, intake.intakeId, [{ practiceArea: "land", assigneeId: uid }])
    expect(routed).toMatchObject({ queue: "lawyer", assigneeId: uid, practiceArea: "land" })
  }, 60_000)
})
