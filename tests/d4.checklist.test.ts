/**
 * L5.4 per-document-type filing readiness (spec lines 3865–3899).
 * The oracle below is the acceptance reading of the doctype row. It is not the implementation.
 * A type has a filing profile only when its own posture or its own annexure/checklist text
 * names a filing accompaniment. Otherwise the checklist is `{ known: false }` and is not a generic list.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  D4_CHECKLIST_FLAG,
  DOCKET_AUTO_TICK_WIRED,
  blockIfIncomplete,
  getChecklistForType,
  getReadiness,
  isD4ChecklistEnabled,
  type ChecklistItem,
  type KnownChecklist,
  type ManualTick,
  type Produced,
} from "@/functions/src/d4/checklist"
import { itemsForDocumentType } from "@/functions/src/d4/checklistProfiles"
import { getDocumentType, listDocumentTypes, type DocumentType } from "@/functions/src/d4/doctypes"

const root = process.cwd()

const FILING_POSTURES = new Set(["writ", "application", "appeal", "originating_pleading", "responsive_pleading"])

function rowHasFilingProfile(type: DocumentType): boolean {
  const lines = type.checklist.join("\n")
  const bundle = `${lines}\n${type.annexureRule}`
  return (
    FILING_POSTURES.has(type.posture) ||
    /\bannexures?\b|\bexhibits?\b/i.test(bundle) ||
    /\baffidavits?\b|\bverification\b/i.test(bundle) ||
    /\bvakalatnama\b/i.test(lines) ||
    /\bindex(?:ed|ing)?\b|\bdocket\b/i.test(bundle) ||
    type.checklist.some((line) => /\bcourt fee\b/i.test(line))
  )
}

function asKnown(id: string): KnownChecklist {
  const checklist = getChecklistForType(id)
  expect(checklist.known, id).toBe(true)
  if (!checklist.known) throw new Error(`expected a checklist for ${id}`)
  return checklist
}

function item(checklist: KnownChecklist, id: string): ChecklistItem {
  const found = checklist.items.find((entry) => entry.id === id)
  expect(found, id).toBeDefined()
  if (!found) throw new Error(`missing item ${id}`)
  return found
}

function mandatoryTicks(checklist: KnownChecklist, except: readonly string[] = []): ManualTick[] {
  return checklist.items
    .filter((entry) => entry.mandatory && !except.includes(entry.id))
    .map((entry) => ({ itemId: entry.id, by: "clerk", at: "2026-11-24T00:00:00.000Z" }))
}

const ITEM_KEYS = ["autoTickWired", "completion", "conditional", "id", "kind", "label", "mandatory", "sourceLines"]

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("getChecklistForType (L5.4, every verified id)", () => {
  it("yields a derived checklist or known: false, and never a generic list", () => {
    const types = listDocumentTypes({})
    expect(types).toHaveLength(159)
    const withoutProfile: string[] = []
    for (const type of types) {
      const checklist = getChecklistForType(type.id)
      if (!rowHasFilingProfile(type)) {
        withoutProfile.push(type.id)
        expect(checklist, type.id).toEqual({ known: false })
        continue
      }
      expect(checklist.known, type.id).toBe(true)
      if (!checklist.known) continue
      expect(checklist.documentTypeId).toBe(type.id)
      expect(checklist.items.length).toBeGreaterThan(0)
      expect(new Set(checklist.items.map((entry) => entry.id)).size).toBe(checklist.items.length)
      const pleading = checklist.items.find((entry) => entry.kind === "pleading")
      expect(Boolean(pleading)).toBe(FILING_POSTURES.has(type.posture))
      if (pleading) expect(pleading.label).toBe(`Pleading: ${type.name}`)
      const fee = checklist.items.find((entry) => entry.kind === "court_fee")
      const feeLine = type.checklist.find((line) => /\bcourt fee\b/i.test(line))
      expect(Boolean(fee)).toBe(Boolean(feeLine))
      if (fee && feeLine) {
        expect(fee.mandatory).toBe(!/\bif\b/i.test(feeLine))
        expect(fee.completion).toBe("manual")
        expect(fee.autoTickWired).toBe(false)
        expect(fee.sourceLines).toContain(feeLine)
        expect(feeLine).toMatch(/MANUAL/i)
        expect(Object.keys(fee).sort()).toEqual(ITEM_KEYS)
        expect(JSON.stringify(fee)).not.toMatch(/\b\d+(?:\.\d+)?\b/)
      }
      expect(checklist.items.some((entry) => entry.kind === "vakalatnama")).toBe(
        type.checklist.some((line) => /\bvakalatnama\b/i.test(line))
      )
      for (const entry of checklist.items) {
        expect(entry.sourceLines.length).toBeGreaterThan(0)
        for (const line of entry.sourceLines) {
          expect(line === type.name || line === type.annexureRule || type.checklist.includes(line), `${type.id} ${entry.id}`).toBe(true)
        }
      }
    }
    expect(withoutProfile).toContain("legal_notice")
    expect(withoutProfile).toContain("legal_opinion")
    expect(withoutProfile).toContain("vakalatnama")
    expect(withoutProfile).toContain("fir_translation")
    expect(withoutProfile.length).toBeGreaterThan(0)
    expect(withoutProfile.length).toBeLessThan(types.length)
  })

  it("a suit, a petition and an application each cite their own row", () => {
    const suit = getDocumentType("civil_suit")!
    const petition = getDocumentType("constitutional_petition_199")!
    const application = getDocumentType("interim_injunction_application")!
    expect(suit.posture).toBe("originating_pleading")
    expect(petition.posture).toBe("writ")
    expect(application.posture).toBe("application")

    const suitList = asKnown(suit.id)
    const petitionList = asKnown(petition.id)
    const applicationList = asKnown(application.id)
    expect(suitList).not.toEqual(petitionList)
    expect(suitList).not.toEqual(applicationList)
    expect(petitionList).not.toEqual(applicationList)

    for (const type of [suit, petition, application]) {
      const checklist = asKnown(type.id)
      const core = ["pleading", "annexures", "verification", "vakalatnama", "index_docket", "court_fee"]
      const mandatoryIds = checklist.items.filter((entry) => entry.mandatory).map((entry) => entry.id)
      expect(mandatoryIds.filter((id) => core.includes(id))).toEqual(core)
      expect(item(checklist, "pleading").label).toBe(`Pleading: ${type.name}`)
      expect(item(checklist, "annexures").sourceLines).toContain(type.annexureRule)
      expect(item(checklist, "verification").sourceLines).toEqual(
        expect.arrayContaining([type.checklist.find((line) => /\baffidavit\b|\bverification\b/i.test(line))])
      )
      expect(item(checklist, "vakalatnama").label).toBe(type.checklist.find((line) => /\bvakalatnama\b/i.test(line)))
      expect(item(checklist, "court_fee").label).toBe(type.checklist.find((line) => /\bcourt fee\b/i.test(line)))
      expect(item(checklist, "index_docket").autoTickWired).toBe(false)
    }

    expect(suit.checklist).toContain("Affidavit / verification")
    expect(suit.checklist).toContain("Vakalatnama")
    expect(application.checklist).toContain("Affidavit in support")
    expect(application.checklist).toContain("Vakalatnama on file")
    expect(item(suitList, "verification").label).toBe("Affidavit / verification")
    expect(item(applicationList, "verification").label).toBe("Affidavit in support")
    expect(item(applicationList, "vakalatnama").label).toBe("Vakalatnama on file")
    expect(suit.annexureRule).not.toBe(petition.annexureRule)
    expect(petition.annexureRule).not.toBe(application.annexureRule)
  })

  it("does not add a slot the row does not name", () => {
    const statement = getDocumentType("written_statement_civil")!
    expect(statement.checklist.some((line) => /\bcourt fee\b/i.test(line))).toBe(false)
    expect(asKnown(statement.id).items.some((entry) => entry.id === "court_fee")).toBe(false)

    const secp = getDocumentType("secp_complaint")!
    expect(secp.checklist.some((line) => /\bvakalatnama\b/i.test(line))).toBe(false)
    expect(secp.checklist.some((line) => /\baffidavit\b|\bverification\b/i.test(line))).toBe(false)
    const secpItems = asKnown(secp.id).items
    expect(secpItems.some((entry) => entry.id === "vakalatnama")).toBe(false)
    expect(secpItems.some((entry) => entry.id === "verification")).toBe(false)

    const nazir = getDocumentType("court_nazir_application")!
    expect(nazir.checklist).toContain("Affidavit if facts asserted")
    expect(nazir.annexureRule).not.toMatch(/\bindex/i)
    const nazirList = asKnown(nazir.id)
    expect(item(nazirList, "verification").mandatory).toBe(true)
    expect(item(asKnown("bail_cancellation"), "vakalatnama")).toMatchObject({
      label: "Vakalatnama on file if counsel",
      conditional: true,
      mandatory: true,
    })
    expect(nazirList.items.some((entry) => entry.id === "court_fee")).toBe(false)
    expect(nazirList.items.some((entry) => entry.id === "index_docket")).toBe(false)

    const deed = getDocumentType("memorandum_of_association")!
    expect(deed.posture).toBe("instrument")
    expect(deed.checklist.some((line) => /\bstamp duty\b/i.test(line))).toBe(true)
    expect(deed.checklist.some((line) => /\bcourt fee\b/i.test(line))).toBe(false)
    const deedList = asKnown(deed.id)
    expect(deedList.items.some((entry) => entry.kind === "pleading")).toBe(false)
    expect(deedList.items.some((entry) => entry.id === "court_fee")).toBe(false)
    expect(item(deedList, "annexures").mandatory).toBe(true)
    expect(item(deedList, "annexures").sourceLines).toContain(deed.annexureRule)
    const duty = deedList.items.find((entry) => entry.sourceLines.some((line) => /\bstamp duty\b/i.test(line)))
    expect(duty?.kind).toBe("type_specific")
    expect(duty?.mandatory).toBe(false)
    expect(duty && Object.keys(duty)).not.toContain("amount")

    const possession = getDocumentType("property_suit_possession")!
    expect(possession.courtIds).toContain("NON_FORUM")
    expect(possession.posture).toBe("originating_pleading")
    expect(asKnown(possession.id).items.some((entry) => entry.kind === "pleading")).toBe(true)

    const affidavit = getDocumentType("affidavit")!
    expect(affidavit.annexureRule).toMatch(/\bif any\b/i)
    const affidavitList = asKnown(affidavit.id)
    expect(affidavitList.items.some((entry) => entry.kind === "pleading")).toBe(false)
    expect(item(affidavitList, "verification").mandatory).toBe(true)
    expect(item(affidavitList, "annexures")).toMatchObject({ mandatory: true, conditional: true })
    expect(item(affidavitList, "annexures").sourceLines).toContain(affidavit.annexureRule)
  })

  it("refuses an unknown id, a prototype name, and an empty or whitespace id", () => {
    for (const id of ["no_such_type", "constructor", "__proto__", "toString", " civil_suit "]) {
      expect(getChecklistForType(id)).toEqual({ known: false })
    }
    for (const id of ["", " ", "\t", "\n", " \t\n "]) {
      expect(getChecklistForType(id)).toEqual({ known: false })
    }
    expect(getChecklistForType(undefined as unknown as string)).toEqual({ known: false })
  })

  it("keeps the court-fee item free of a computed figure, and the module free of fee arithmetic", () => {
    const source = ["functions/src/d4/checklist.ts", "functions/src/d4/checklistProfiles.ts"]
      .map((file) => readFileSync(path.join(root, file), "utf8"))
      .join("\n")
    expect(source).not.toMatch(/\bamount\b/i)
    expect(source).not.toMatch(/\brupees?\b|\bRs\b/i)
    expect(source).not.toMatch(/\bpaise\b/i)
    expect(source).not.toMatch(/Math\./)
    expect(source).not.toMatch(/\d+\s*[*x×/]\s*\d+/)
    expect(source).not.toMatch(/\bfirebase\b|\bfirestore\b/i)
    expect(source).not.toMatch(/from\s+["']\.\/gateOps["']/)
    const fee = item(asKnown("civil_suit"), "court_fee")
    expect(fee.kind).toBe("court_fee")
    expect("amount" in fee).toBe(false)
  })
})

describe("getReadiness and blockIfIncomplete", () => {
  it("an affidavit id alone does not make a heirship affidavit ready without the death certificate", () => {
    const type = getDocumentType("heirship_affidavit")!
    expect(type.checklist).toContain("Death certificate annexed")
    expect(type.annexureRule).toMatch(/\bif any\b/i)
    const produced = { affidavitId: "aff-1" }
    const readiness = getReadiness(type.id, produced)
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    expect(readiness.readyToFile).toBe(false)
    const missing = readiness.items.filter((entry) => readiness.missingMandatory.includes(entry.id))
    expect(missing.map((entry) => entry.label)).toContain("Death certificate annexed")
    expect(missing.every((entry) => entry.mandatory)).toBe(true)
    const blocked = blockIfIncomplete(type.id, produced)
    expect(blocked.blocked).toBe(true)
    expect(blocked.missingMandatory).toEqual(readiness.missingMandatory)
  })

  function partsFrom(checklist: KnownChecklist, line: string): ChecklistItem[] {
    return checklist.items.filter((entry) => entry.kind === "annexures" && entry.sourceLines.includes(line))
  }

  function withoutItem(checklist: KnownChecklist, holdOut: string): Produced {
    const annexureIds: string[] = []
    const manualTicks: ManualTick[] = []
    let affidavitId: string | undefined
    for (const entry of checklist.items) {
      if (!entry.mandatory || entry.id === holdOut) continue
      if (entry.completion === "annexures") annexureIds.push(entry.id)
      else if (entry.completion === "affidavit") affidavitId = "aff-1"
      else manualTicks.push({ itemId: entry.id, by: "clerk", at: "2026-11-24T00:00:00.000Z" })
    }
    return { affidavitId, annexureIds, manualTicks }
  }

  it("splits a cheque, dishonour memo and notice into three items and leaves each one out", () => {
    const line = "Cheque, dishonour memo and notice annexed"
    const checklist = asKnown("cheque_dishonour_complaint_489f")
    const parts = partsFrom(checklist, line)
    expect(parts.map((entry) => entry.label)).toEqual(["Cheque annexed", "dishonour memo annexed", "notice annexed"])
    expect(new Set(parts.map((entry) => entry.id)).size).toBe(3)
    for (const part of parts) {
      const produced = withoutItem(checklist, part.id)
      const readiness = getReadiness(checklist.documentTypeId, produced)
      expect(readiness.known).toBe(true)
      if (!readiness.known) continue
      expect(readiness.readyToFile, part.label).toBe(false)
      expect(readiness.missingMandatory, part.label).toEqual([part.id])
      const siblings = readiness.items.filter((entry) => parts.some((item) => item.id === entry.id))
      expect(siblings.filter((entry) => entry.done)).toHaveLength(2)
      expect(siblings.find((entry) => entry.id === part.id)?.done).toBe(false)
    }
    const onlyFirst: Produced = { annexureIds: [parts[0].id] }
    const firstOnly = getReadiness(checklist.documentTypeId, onlyFirst)
    expect(firstOnly.known).toBe(true)
    if (!firstOnly.known) return
    const closed = firstOnly.items.filter((entry) => parts.some((item) => item.id === entry.id) && entry.done)
    expect(closed).toHaveLength(1)
  })

  it("splits an impugned judgment, the warrant and the jail roll and leaves each one out", () => {
    const line = "Impugned judgment and warrant / jail roll annexed"
    const checklist = asKnown("conviction_appeal")
    const parts = partsFrom(checklist, line)
    expect(parts.map((entry) => entry.label)).toEqual([
      "Impugned judgment annexed",
      "warrant annexed",
      "jail roll annexed",
    ])
    for (const part of parts) {
      const readiness = getReadiness(checklist.documentTypeId, withoutItem(checklist, part.id))
      expect(readiness.known).toBe(true)
      if (!readiness.known) continue
      expect(readiness.readyToFile, part.label).toBe(false)
      expect(readiness.missingMandatory, part.label).toContain(part.id)
      expect(readiness.items.find((entry) => entry.id === part.id)?.done).toBe(false)
    }
  })

  it("a criminal revision keeps the certified copy of the impugned order", () => {
    const type = getDocumentType("criminal_revision")!
    const checklist = asKnown(type.id)
    const copy = checklist.items.find(
      (entry) => entry.kind === "annexures" && /\bcertified\b/i.test(entry.label) && /\bimpugned\b/i.test(entry.label)
    )
    expect(copy).toBeDefined()
    expect(copy?.sourceLines).toContain(type.annexureRule)
  })

  it("the criminal revision certified copy is mandatory", () => {
    const checklist = asKnown("criminal_revision")
    const copy = checklist.items.find(
      (entry) => entry.kind === "annexures" && /\bcertified\b/i.test(entry.label) && /\bimpugned\b/i.test(entry.label)
    )
    expect(copy?.mandatory).toBe(true)
  })

  it("keeps a certified copy of the impugned order beside the judgment on acquittal, conviction and sentence appeals", () => {
    for (const id of ["acquittal_appeal", "conviction_appeal", "sentence_appeal"]) {
      const checklist = asKnown(id)
      const copy = checklist.items.find(
        (entry) => entry.kind === "annexures" && /\bcertified\b/i.test(entry.label) && /\bimpugned\b/i.test(entry.label)
      )
      expect(copy, id).toBeDefined()
      expect(copy?.mandatory, id).toBe(true)
      expect(copy?.conditional, id).toBe(false)
    }
  })

  it("the record relied on stays its own mandatory annexure", () => {
    for (const id of ["civil_appeal", "criminal_revision", "conviction_appeal"]) {
      const record = asKnown(id).items.find((entry) => /\brecord relied on\b/i.test(entry.label))
      expect(record, id).toMatchObject({ mandatory: true, kind: "annexures" })
    }
  })

  it("an open conditional blocks, and a not-applicable tick with who and when unblocks", () => {
    const appeal = asKnown("civil_appeal")
    const condonation = appeal.items.find((entry) => entry.label === "Condonation application if delayed")
    const limitation = appeal.items.find((entry) => entry.label === "Impugned order date and limitation computed (Module 44)")
    expect(condonation).toMatchObject({ conditional: true, mandatory: true })
    expect(limitation).toMatchObject({ conditional: false, mandatory: true })
    const open = getReadiness(appeal.documentTypeId, withoutItem(appeal, condonation!.id))
    expect(open.known).toBe(true)
    if (!open.known) return
    expect(open.readyToFile).toBe(false)
    expect(open.missingMandatory).toContain(condonation!.id)

    const waived = getReadiness(appeal.documentTypeId, {
      ...withoutItem(appeal, condonation!.id),
      manualTicks: [
        ...withoutItem(appeal, condonation!.id).manualTicks!,
        { itemId: condonation!.id, by: "clerk", at: "2026-11-24T00:00:00.000Z", notApplicable: true },
      ],
    })
    expect(waived.known).toBe(true)
    if (!waived.known) return
    expect(waived.readyToFile).toBe(true)
    expect(waived.items.find((entry) => entry.id === condonation!.id)).toMatchObject({
      done: true,
      completedBy: "not_applicable",
      actor: { by: "clerk", at: "2026-11-24T00:00:00.000Z" },
    })

    const counsel = asKnown("bail_cancellation")
    const vakalatnama = item(counsel, "vakalatnama")
    expect(vakalatnama.label).toBe("Vakalatnama on file if counsel")
    expect(vakalatnama.conditional).toBe(true)
    const counselOpen = getReadiness(counsel.documentTypeId, withoutItem(counsel, vakalatnama.id))
    expect(counselOpen.known).toBe(true)
    if (!counselOpen.known) return
    expect(counselOpen.readyToFile).toBe(false)
    const counselWaived = getReadiness(counsel.documentTypeId, {
      ...withoutItem(counsel, vakalatnama.id),
      manualTicks: [
        ...(withoutItem(counsel, vakalatnama.id).manualTicks ?? []),
        { itemId: vakalatnama.id, by: "clerk", at: "2026-11-24", notApplicable: true },
      ],
    })
    expect(counselWaived.known).toBe(true)
    if (!counselWaived.known) return
    expect(counselWaived.readyToFile).toBe(true)

    const exhibitType = asKnown("affidavit")
    const exhibits = item(exhibitType, "annexures")
    expect(exhibits.conditional).toBe(true)
    const exhibitOpen = getReadiness(exhibitType.documentTypeId, withoutItem(exhibitType, exhibits.id))
    expect(exhibitOpen.known).toBe(true)
    if (!exhibitOpen.known) return
    expect(exhibitOpen.readyToFile).toBe(false)
    expect(exhibitOpen.missingMandatory).toContain(exhibits.id)

    let condonationCount = 0
    let counselCount = 0
    let exhibitCount = 0
    let limitationCount = 0
    for (const type of listDocumentTypes({})) {
      const checklist = getChecklistForType(type.id)
      if (!checklist.known) continue
      for (const entry of checklist.items) {
        if (entry.label === "Condonation application if delayed") {
          condonationCount += 1
          expect(entry, type.id).toMatchObject({ conditional: true, mandatory: true })
        }
        if (entry.label === "Vakalatnama on file if counsel") {
          counselCount += 1
          expect(entry, type.id).toMatchObject({ conditional: true, mandatory: true })
        }
        if (entry.kind !== "pleading" && /\blimitation\b/i.test(entry.label)) {
          limitationCount += 1
          const explicit = /\bif any\b|\bwhere applicable\b|\bas applicable\b|\bif counsel\b|\bif delayed\b/i.test(entry.label)
          expect(entry, type.id).toMatchObject({ conditional: explicit, mandatory: true })
        }
      }
      if (/\bif any\b/i.test(type.annexureRule) && /\bexhibits?\b/i.test(type.annexureRule)) {
        exhibitCount += 1
        expect(item(checklist, "annexures"), type.id).toMatchObject({ conditional: true, mandatory: true })
      }
    }
    expect(condonationCount).toBe(10)
    expect(counselCount).toBe(21)
    expect(exhibitCount).toBe(6)
    expect(limitationCount).toBeGreaterThan(0)
  })

  it("rejects a not-applicable tick with no who or when, or with an invalid date", () => {
    const appeal = asKnown("civil_appeal")
    const condonation = appeal.items.find((entry) => entry.label === "Condonation application if delayed")!
    const base = withoutItem(appeal, condonation.id)
    for (const tick of [
      { itemId: condonation.id, by: " ", at: "2026-11-24T00:00:00.000Z", notApplicable: true },
      { itemId: condonation.id, by: "clerk", at: "  ", notApplicable: true },
      { itemId: condonation.id, by: "clerk", at: "not-a-date", notApplicable: true },
    ]) {
      const readiness = getReadiness(appeal.documentTypeId, { ...base, manualTicks: [...(base.manualTicks ?? []), tick] })
      expect(readiness.known).toBe(true)
      if (!readiness.known) continue
      expect(readiness.readyToFile, tick.at).toBe(false)
      expect(readiness.missingMandatory, tick.at).toContain(condonation.id)
    }
    const suit = asKnown("civil_suit")
    const dated = getReadiness("civil_suit", {
      manualTicks: [{ itemId: "pleading", by: "clerk", at: "not-a-date" }],
    })
    expect(dated.known).toBe(true)
    if (!dated.known) return
    expect(dated.items.find((entry) => entry.id === "pleading")?.done).toBe(false)
    expect(suit.items.find((entry) => /Limitation checked/i.test(entry.label))).toMatchObject({
      conditional: false,
      mandatory: true,
    })
  })

  it("a not-applicable tick is not counted as a manual close of the certified copy", () => {
    const appeal = asKnown("civil_appeal")
    const copy = appeal.items.find(
      (entry) => entry.kind === "annexures" && /\bcertified\b/i.test(entry.label) && /\bimpugned\b/i.test(entry.label)
    )!
    const held = withoutItem(appeal, copy.id)
    const readiness = getReadiness(appeal.documentTypeId, {
      ...held,
      manualTicks: [...(held.manualTicks ?? []), { itemId: copy.id, by: "clerk", at: "2026-11-24T00:00:00.000Z", notApplicable: true }],
    })
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    expect(readiness.items.find((entry) => entry.id === copy.id)?.completedBy).not.toBe("manual")
  })

  it("a not-applicable tick does not close the certified copy", () => {
    const appeal = asKnown("civil_appeal")
    const copy = appeal.items.find(
      (entry) => entry.kind === "annexures" && /\bcertified\b/i.test(entry.label) && /\bimpugned\b/i.test(entry.label)
    )!
    expect(copy.conditional).toBe(false)
    const held = withoutItem(appeal, copy.id)
    const readiness = getReadiness(appeal.documentTypeId, {
      ...held,
      manualTicks: [...(held.manualTicks ?? []), { itemId: copy.id, by: "clerk", at: "2026-11-24T00:00:00.000Z", notApplicable: true }],
    })
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    const closed = readiness.items.find((entry) => entry.id === copy.id)
    expect(closed?.done).toBe(false)
    expect(closed?.completedBy).toBe(null)
    expect(readiness.readyToFile).toBe(false)
    expect(readiness.missingMandatory).toContain(copy.id)
  })

  it("accepts an offset that crosses UTC midnight", () => {
    const suit = asKnown("civil_suit")
    const held = withoutItem(suit, "pleading")
    for (const at of ["2026-11-24T03:00:00+05:00", "2026-11-24T22:00:00-05:00"]) {
      const readiness = getReadiness("civil_suit", {
        ...held,
        manualTicks: [...(held.manualTicks ?? []), { itemId: "pleading", by: "clerk", at }],
      })
      expect(readiness.known).toBe(true)
      if (!readiness.known) continue
      expect(readiness.items.find((entry) => entry.id === "pleading")?.done, at).toBe(true)
      expect(readiness.readyToFile, at).toBe(true)
    }
  })

  it("rejects a date-only day that does not round-trip", () => {
    const dated = getReadiness("civil_suit", {
      manualTicks: [{ itemId: "pleading", by: "clerk", at: "2026-02-31" }],
    })
    expect(dated.known).toBe(true)
    if (!dated.known) return
    expect(dated.items.find((entry) => entry.id === "pleading")?.done).toBe(false)
  })

  it("rejects an impossible calendar day and a year outside 1900 through 2100", () => {
    const suit = asKnown("civil_suit")
    const held = withoutItem(suit, "pleading")
    for (const at of ["2026-02-30T00:00:00Z", "2026-02-31", "2026-02-29", "9999-12-31", "0000-01-01", "1899-12-31", "2101-01-01"]) {
      const readiness = getReadiness("civil_suit", {
        ...held,
        manualTicks: [...(held.manualTicks ?? []), { itemId: "pleading", by: "clerk", at }],
      })
      expect(readiness.known).toBe(true)
      if (!readiness.known) continue
      expect(readiness.readyToFile, at).toBe(false)
      expect(readiness.missingMandatory, at).toContain("pleading")
      expect(readiness.items.find((entry) => entry.id === "pleading")?.done, at).toBe(false)
    }
    for (const at of ["1900-01-01", "2100-12-31", "2024-02-29", "2026-11-24T00:00:00.000Z"]) {
      const readiness = getReadiness("civil_suit", {
        ...held,
        manualTicks: [...(held.manualTicks ?? []), { itemId: "pleading", by: "clerk", at }],
      })
      expect(readiness.known).toBe(true)
      if (!readiness.known) continue
      expect(readiness.items.find((entry) => entry.id === "pleading")?.done, at).toBe(true)
    }
  })

  it("rejects a clock that is not a real time", () => {
    const suit = asKnown("civil_suit")
    const held = withoutItem(suit, "pleading")
    for (const at of ["2026-11-24T24:00:00Z", "2026-11-24T03:60:00+05:00", "2026-11-24T03:00:60Z"]) {
      const readiness = getReadiness("civil_suit", {
        ...held,
        manualTicks: [...(held.manualTicks ?? []), { itemId: "pleading", by: "clerk", at }],
      })
      expect(readiness.known).toBe(true)
      if (!readiness.known) continue
      expect(readiness.items.find((entry) => entry.id === "pleading")?.done, at).toBe(false)
    }
  })

  it("rejects an offset that is not a real zone", () => {
    const suit = asKnown("civil_suit")
    const held = withoutItem(suit, "pleading")
    for (const at of ["2026-11-24T03:00:00+24:00", "2026-11-24T12:00:00+05:60"]) {
      const readiness = getReadiness("civil_suit", {
        ...held,
        manualTicks: [...(held.manualTicks ?? []), { itemId: "pleading", by: "clerk", at }],
      })
      expect(readiness.known).toBe(true)
      if (!readiness.known) continue
      expect(readiness.items.find((entry) => entry.id === "pleading")?.done, at).toBe(false)
    }
  })

  it("rejects a not-applicable tick on an unconditional limitation line", () => {
    const rows = [
      { id: "civil_suit", label: /Limitation checked/i },
      { id: "constitutional_petition_199", label: /^Limitation \/ laches addressed$/i },
      { id: "civil_appeal", label: /date and limitation computed/i },
    ]
    for (const row of rows) {
      const checklist = asKnown(row.id)
      const line = checklist.items.find((entry) => row.label.test(entry.label))
      expect(line, row.id).toMatchObject({ mandatory: true, conditional: false })
      const held = withoutItem(checklist, line!.id)
      const waived = getReadiness(row.id, {
        ...held,
        manualTicks: [
          ...(held.manualTicks ?? []),
          { itemId: line!.id, by: "clerk", at: "2026-11-24T00:00:00.000Z", notApplicable: true },
        ],
      })
      expect(waived.known).toBe(true)
      if (!waived.known) continue
      expect(waived.readyToFile, row.id).toBe(false)
      expect(waived.missingMandatory, row.id).toContain(line!.id)
      expect(waived.items.find((entry) => entry.id === line!.id)?.completedBy, row.id).toBe(null)
      const produced = getReadiness(row.id, withoutItem(checklist, "none"))
      expect(produced.known).toBe(true)
      if (!produced.known) continue
      expect(produced.items.find((entry) => entry.id === line!.id), row.id).toMatchObject({
        done: true,
        completedBy: "manual",
      })
    }
    const counsel = asKnown("bail_cancellation")
    const delay = counsel.items.find((entry) => entry.label === "Limitation / delay explained if any")!
    expect(delay).toMatchObject({ conditional: true, mandatory: true })
    const held = withoutItem(counsel, delay.id)
    const waived = getReadiness(counsel.documentTypeId, {
      ...held,
      manualTicks: [...(held.manualTicks ?? []), { itemId: delay.id, by: "clerk", at: "2026-11-24", notApplicable: true }],
    })
    expect(waived.known).toBe(true)
    if (!waived.known) return
    expect(waived.readyToFile).toBe(true)
    expect(waived.items.find((entry) => entry.id === delay.id)?.completedBy).toBe("not_applicable")
  })

  it("keeps a certified copy on every split part and does not leave a preposition fragment", () => {
    const base = getDocumentType("affidavit")!
    const decree = itemsForDocumentType({
      ...base,
      id: "certified_judgment_and_decree",
      name: "Certified judgment and decree",
      checklist: ["Certified copy of the judgment and decree annexed"],
      annexureRule: "Exhibits, if any",
    })
    expect(decree.filter((entry) => entry.kind === "annexures" && entry.id !== "annexures").map((entry) => entry.label)).toEqual([
      "Certified copy of the judgment annexed",
      "Certified copy of the decree annexed",
    ])
    const courts = itemsForDocumentType({
      ...base,
      id: "judgment_of_two_courts",
      name: "Judgment of two courts",
      checklist: ["Certified copy of the judgment of the trial court and of the appellate court annexed"],
      annexureRule: "Legal size",
    })
    const line = "Certified copy of the judgment of the trial court and of the appellate court annexed"
    expect(courts.filter((entry) => entry.sourceLines.includes(line)).map((entry) => entry.label)).toEqual([
      "Certified copy of the judgment of the trial court annexed",
      "Certified copy of the appellate court annexed",
    ])
  })

  it("splits a certified-copies line at 'and of' and keeps the prefix on each part", () => {
    const base = getDocumentType("affidavit")!
    const courts = itemsForDocumentType({
      ...base,
      id: "copies_of_two_courts",
      name: "Copies of two courts",
      checklist: ["Certified copies of the judgment of the trial court and of the appellate court annexed"],
      annexureRule: "Legal size",
    })
    expect(
      courts
        .filter((entry) => entry.sourceLines.includes("Certified copies of the judgment of the trial court and of the appellate court annexed"))
        .map((entry) => entry.label)
    ).toEqual([
      "Certified copies of the judgment of the trial court annexed",
      "Certified copies of the appellate court annexed",
    ])
    const bail = itemsForDocumentType({
      ...base,
      id: "copies_of_bail_and_fir",
      name: "Copies of bail and FIR",
      checklist: ["Certified copies of the order for bail and of the FIR annexed"],
      annexureRule: "Legal size",
    })
    expect(
      bail.filter((entry) => entry.sourceLines.includes("Certified copies of the order for bail and of the FIR annexed")).map((entry) => entry.label)
    ).toEqual(["Certified copies of the order for bail annexed", "Certified copies of the FIR annexed"])
  })

  it("every split part of every seed row is a document name", () => {
    const documentWord =
      /\b(cheque|dishonour|memo|notice|judgment|warrant|jail|roll|decree|order|certificate|affidavit|copy|petition|record|exhibit|document|complaint|charge|sentence|bail|plaint|annexure)\b/i
    let splitRows = 0
    for (const type of listDocumentTypes({})) {
      const checklist = getChecklistForType(type.id)
      if (!checklist.known) continue
      for (const line of type.checklist) {
        const parts = checklist.items.filter(
          (entry) => entry.kind === "annexures" && entry.sourceLines.length === 1 && entry.sourceLines[0] === line
        )
        if (parts.length < 2) continue
        splitRows += 1
        for (const entry of parts) {
          const body = entry.label.replace(/\s+annexed\s*$/i, "").trim()
          expect(body, `${type.id} ${entry.label}`).not.toMatch(/^(of|for|to|in|on|with|under|from|and)\b/i)
          expect(body, `${type.id} ${entry.label}`).toMatch(documentWord)
          if (/\bcertified cop(?:y|ies)\b/i.test(line)) expect(entry.label, type.id).toMatch(/\bcertified cop(?:y|ies)\b/i)
        }
      }
    }
    expect(splitRows).toBeGreaterThan(0)
  })

  it("one annexure id does not tick every mandatory annexure", () => {
    const checklist = asKnown("civil_appeal")
    const annexureItems = checklist.items.filter((entry) => entry.mandatory && entry.completion === "annexures")
    expect(annexureItems.length).toBeGreaterThan(1)
    const produced: Produced = {
      affidavitId: "aff-1",
      annexureIds: [annexureItems[0].id],
      manualTicks: mandatoryTicks(checklist).filter(
        (tick) => tick.itemId !== "verification" && !annexureItems.some((entry) => entry.id === tick.itemId)
      ),
    }
    const readiness = getReadiness("civil_appeal", produced)
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    const done = readiness.items.filter((entry) => annexureItems.some((item) => item.id === entry.id) && entry.done)
    expect(done).toHaveLength(1)
    expect(done[0]?.id).toBe(annexureItems[0].id)
    expect(readiness.readyToFile).toBe(false)
  })

  it("a civil appeal is not ready to file without the certified copy of the impugned order", () => {
    const checklist = asKnown("civil_appeal")
    const certified = checklist.items.filter(
      (entry) => entry.mandatory && /certified copy/i.test(entry.label) && /impugned order|decree/i.test(entry.label)
    )
    expect(certified.length).toBeGreaterThan(0)
    expect(certified.every((entry) => entry.id !== "annexures")).toBe(true)
    const annexureIds = checklist.items
      .filter((entry) => entry.mandatory && entry.completion === "annexures" && !certified.some((item) => item.id === entry.id))
      .map((entry) => entry.id)
    expect(annexureIds.length).toBeGreaterThan(0)
    const produced: Produced = {
      affidavitId: "aff-1",
      annexureIds,
      manualTicks: mandatoryTicks(checklist).filter(
        (tick) => tick.itemId !== "verification" && !checklist.items.some((entry) => entry.completion === "annexures" && entry.id === tick.itemId)
      ),
    }
    const readiness = getReadiness("civil_appeal", produced)
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    expect(readiness.readyToFile).toBe(false)
    expect(readiness.missingMandatory).toEqual(certified.map((entry) => entry.id))
    const blocked = blockIfIncomplete("civil_appeal", produced)
    expect(blocked.blocked).toBe(true)
    expect(blocked.missingMandatory).toEqual(certified.map((entry) => entry.id))
  })

  it("a contempt application is not ready to file without the certified copy of the order disobeyed", () => {
    const checklist = asKnown("contempt_application")
    const copy = checklist.items.find((entry) => entry.label === "Certified copy of the order disobeyed")
    expect(copy).toBeDefined()
    expect(copy?.mandatory).toBe(true)
    expect(copy?.id).not.toBe("annexures")
    const annexureIds = checklist.items
      .filter((entry) => entry.mandatory && entry.completion === "annexures" && entry.id !== copy?.id)
      .map((entry) => entry.id)
    const produced: Produced = {
      affidavitId: "aff-1",
      annexureIds,
      manualTicks: mandatoryTicks(checklist).filter(
        (tick) => tick.itemId !== "verification" && tick.itemId !== copy?.id && !annexureIds.includes(tick.itemId)
      ),
    }
    const readiness = getReadiness("contempt_application", produced)
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    expect(readiness.readyToFile).toBe(false)
    expect(readiness.missingMandatory).toEqual([copy?.id])
    expect(readiness.items.find((entry) => entry.id === copy?.id)?.label).toBe("Certified copy of the order disobeyed")
  })

  it("treats an unconditional annexed line as a required annexure and keeps a conditional exhibit fail-closed", () => {
    const conditional = /\bif any\b|\bwhere applicable\b|\bas applicable\b/i
    for (const type of listDocumentTypes({})) {
      const annexed = type.checklist.filter((line) => /\bannexed\b/i.test(line) && !conditional.test(line))
      if (annexed.length === 0) continue
      const checklist = asKnown(type.id)
      for (const line of annexed) {
        const slot = checklist.items.find((entry) => entry.kind === "annexures" && entry.sourceLines.includes(line))
        expect(slot, `${type.id} ${line}`).toBeDefined()
        expect(slot?.mandatory, type.id).toBe(true)
        expect(slot?.id, type.id).not.toBe("annexures")
        expect(
          checklist.items.some((entry) => entry.kind === "type_specific" && entry.sourceLines.includes(line)),
          type.id
        ).toBe(false)
      }
    }
    for (const id of ["affidavit", "statutory_declaration", "affidavit_in_evidence", "affidavit_of_service", "guardianship_affidavit"]) {
      const row = getDocumentType(id)!
      expect(row.annexureRule).toMatch(/\bif any\b/i)
      expect(row.checklist.some((line) => /\bannexed\b/i.test(line))).toBe(false)
      expect(item(asKnown(id), "annexures")).toMatchObject({ mandatory: true, conditional: true })
    }
    const applicable = itemsForDocumentType({
      ...getDocumentType("affidavit")!,
      id: "exhibits_where_applicable",
      name: "Exhibits where applicable",
      checklist: ["Exhibits where applicable"],
      annexureRule: "Exhibits where applicable",
    })
    expect(applicable.find((entry) => entry.id === "annexures")).toMatchObject({ mandatory: true, conditional: true })
    const decree = itemsForDocumentType({
      ...getDocumentType("affidavit")!,
      id: "decree_copy",
      name: "Decree copy",
      checklist: ["Certified copy of the decree"],
      annexureRule: "Exhibits, if any",
    })
    expect(decree.find((entry) => entry.label === "Certified copy of the decree")).toMatchObject({
      mandatory: true,
      completion: "annexures",
    })
    expect(decree.find((entry) => entry.id === "annexures")).toMatchObject({ mandatory: true, conditional: true })
  })

  it("a missing mandatory item is not ready to file, and names that item", () => {
    const checklist = asKnown("civil_suit")
    const produced: Produced = { manualTicks: mandatoryTicks(checklist, ["court_fee"]) }
    const readiness = getReadiness("civil_suit", produced)
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    expect(readiness.readyToFile).toBe(false)
    expect(readiness.missingMandatory).toEqual(["court_fee"])
    expect(readiness.items.find((entry) => entry.id === "court_fee")?.done).toBe(false)
    const blocked = blockIfIncomplete("civil_suit", produced)
    expect(blocked).toEqual({
      blocked: true,
      reason: "filing_incomplete: court_fee",
      missingMandatory: ["court_fee"],
    })
  })

  it("is ready to file only when every mandatory item is present", () => {
    const checklist = asKnown("civil_suit")
    const produced: Produced = {
      affidavitId: "affidavit-1",
      annexureIds: ["", "  ", "annexures"],
      docketId: "docket-not-wired",
      manualTicks: mandatoryTicks(checklist).filter((tick) => tick.itemId !== "verification" && tick.itemId !== "annexures"),
    }
    const readiness = getReadiness("civil_suit", produced)
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    expect(readiness.readyToFile).toBe(true)
    expect(readiness.missingMandatory).toEqual([])
    expect(readiness.items.find((entry) => entry.id === "verification")).toMatchObject({
      done: true,
      completedBy: "affidavit",
      actor: null,
    })
    expect(readiness.items.find((entry) => entry.id === "annexures")).toMatchObject({
      done: true,
      completedBy: "annexures",
      actor: null,
    })
    expect(readiness.items.find((entry) => entry.id === "court_fee")).toMatchObject({
      done: true,
      completedBy: "manual",
      actor: { by: "clerk", at: "2026-11-24T00:00:00.000Z" },
    })
    expect(readiness.progress).toMatchObject({
      mandatoryDone: readiness.progress.mandatoryTotal,
      total: readiness.items.length,
    })
    expect(readiness.progress.done).toBeLessThan(readiness.progress.total)
    expect(blockIfIncomplete("civil_suit", produced)).toEqual({
      blocked: false,
      reason: null,
      missingMandatory: [],
    })
  })

  it("leaves an optional item open without blocking, and requires an affidavit that is not an explicit conditional", () => {
    const suit = asKnown("civil_suit")
    const cause = suit.items.find((entry) => entry.sourceLines.includes("Cause title and court correct"))
    expect(cause?.mandatory).toBe(false)
    expect(cause?.kind).toBe("type_specific")
    const ready = getReadiness("civil_suit", { manualTicks: mandatoryTicks(suit) })
    expect(ready.known).toBe(true)
    if (!ready.known) return
    expect(ready.readyToFile).toBe(true)
    expect(ready.items.find((entry) => entry.id === cause?.id)?.done).toBe(false)

    const nazir = asKnown("court_nazir_application")
    expect(item(nazir, "verification").label).toBe("Affidavit if facts asserted")
    expect(item(nazir, "verification").mandatory).toBe(true)
    const open = getReadiness("court_nazir_application", { manualTicks: mandatoryTicks(nazir, ["verification"]) })
    expect(open.known).toBe(true)
    if (!open.known) return
    expect(open.readyToFile).toBe(false)
    expect(open.missingMandatory).toEqual(["verification"])
    const sworn = getReadiness("court_nazir_application", { affidavitId: "aff-1", manualTicks: mandatoryTicks(nazir, ["verification"]) })
    expect(sworn.known).toBe(true)
    if (!sworn.known) return
    expect(sworn.readyToFile).toBe(true)
    expect(item(asKnown("bail_cancellation"), "vakalatnama")).toMatchObject({ conditional: true, mandatory: true })
    const particulars = asKnown("criminal_revision").items.find((entry) => entry.label === "FIR / complaint / judgment particulars as applicable")
    expect(particulars).toMatchObject({ conditional: true, mandatory: true })
    const limitation = asKnown("civil_appeal").items.find((entry) => /date and limitation/i.test(entry.label))
    expect(limitation).toMatchObject({ conditional: false, mandatory: true, kind: "type_specific" })
  })

  it("does not auto-tick the index from a docket id while the L5.5 seam is unwired", () => {
    expect(DOCKET_AUTO_TICK_WIRED).toBe(false)
    const checklist = asKnown("civil_suit")
    expect(item(checklist, "index_docket").autoTickWired).toBe(false)
    expect(item(checklist, "index_docket").completion).toBe("docket")
    const produced: Produced = {
      docketId: "docket-1",
      manualTicks: mandatoryTicks(checklist, ["index_docket"]),
    }
    const readiness = getReadiness("civil_suit", produced)
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    expect(readiness.docketAutoTickWired).toBe(false)
    expect(readiness.readyToFile).toBe(false)
    expect(readiness.missingMandatory).toEqual(["index_docket"])
    expect(readiness.items.find((entry) => entry.id === "index_docket")?.done).toBe(false)
    expect(JSON.stringify(readiness)).not.toContain("5000")
  })

  it("ignores a manual tick with no who or when, and ignores a blank affidavit or annexure id", () => {
    const checklist = asKnown("civil_suit")
    const produced: Produced = {
      affidavitId: "  ",
      annexureIds: ["", "   "],
      manualTicks: [
        { itemId: "pleading", by: " ", at: "2026-11-24T00:00:00.000Z" },
        { itemId: "court_fee", by: "clerk", at: "  " },
        { itemId: "vakalatnama", by: "clerk", at: "2026-11-24" },
      ],
    }
    const readiness = getReadiness("civil_suit", produced)
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    expect(readiness.items.find((entry) => entry.id === "pleading")?.done).toBe(false)
    expect(readiness.items.find((entry) => entry.id === "court_fee")?.done).toBe(false)
    expect(readiness.items.find((entry) => entry.id === "verification")?.done).toBe(false)
    expect(readiness.items.find((entry) => entry.id === "annexures")?.done).toBe(false)
    expect(readiness.items.find((entry) => entry.id === "vakalatnama")).toMatchObject({
      done: true,
      actor: { by: "clerk", at: "2026-11-24" },
    })
    expect(readiness.readyToFile).toBe(false)
    const blocked = blockIfIncomplete("civil_suit", produced)
    expect(blocked.blocked).toBe(true)
    expect(blocked.missingMandatory).toEqual(
      checklist.items.filter((entry) => entry.mandatory && entry.id !== "vakalatnama").map((entry) => entry.id)
    )
  })

  it("refuses an unknown type and an empty id, and does not call either one ready", () => {
    expect(getReadiness("no_such_type", {})).toEqual({
      known: false,
      reason: "unknown_type",
      readyToFile: false,
      missingMandatory: [],
      progress: { done: 0, total: 0, mandatoryDone: 0, mandatoryTotal: 0 },
      items: [],
      docketAutoTickWired: false,
    })
    expect(blockIfIncomplete("no_such_type", {})).toEqual({
      blocked: true,
      reason: "unknown_type",
      missingMandatory: [],
    })
    for (const id of ["", " ", "\n"]) {
      expect(getReadiness(id, {})).toMatchObject({ known: false, reason: "empty_document_type", readyToFile: false })
      expect(blockIfIncomplete(id, {})).toEqual({ blocked: true, reason: "empty_document_type", missingMandatory: [] })
    }
    expect(getReadiness("legal_notice", { docketId: "d1", affidavitId: "a1" })).toMatchObject({
      known: false,
      reason: "no_filing_profile",
      readyToFile: false,
    })
    expect(blockIfIncomplete("legal_opinion", {})).toEqual({
      blocked: true,
      reason: "no_filing_profile",
      missingMandatory: [],
    })
  })

  it("names every missing mandatory item, in checklist order, when nothing has been produced", () => {
    const checklist = asKnown("civil_suit")
    const readiness = getReadiness("civil_suit", {})
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    const mandatory = checklist.items.filter((entry) => entry.mandatory).map((entry) => entry.id)
    expect(readiness.missingMandatory).toEqual(mandatory)
    expect(readiness.progress).toEqual({ done: 0, total: checklist.items.length, mandatoryDone: 0, mandatoryTotal: mandatory.length })
    expect(readiness.readyToFile).toBe(false)
    expect(blockIfIncomplete("civil_suit", undefined).reason).toBe(`filing_incomplete: ${mandatory.join(", ")}`)
  })

  it("does not let a produced figure complete the court-fee tick", () => {
    const checklist = asKnown("sale_deed")
    const produced = {
      manualTicks: mandatoryTicks(checklist, ["court_fee"]),
      feeFigure: 5000,
    }
    const readiness = getReadiness("sale_deed", produced)
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    expect(readiness.missingMandatory).toEqual(["court_fee"])
    expect(JSON.stringify(readiness.items.find((entry) => entry.id === "court_fee"))).not.toContain("5000")
    expect(blockIfIncomplete("sale_deed", produced).reason).toBe("filing_incomplete: court_fee")
  })

  it("uses the last valid manual tick and ignores prototype-shaped item ids", () => {
    const readiness = getReadiness("court_nazir_application", {
      manualTicks: [
        { itemId: "__proto__", by: "x", at: "t" },
        { itemId: "constructor", by: "x", at: "t" },
        { itemId: "pleading", by: "first", at: "2026-11-24T00:00:00.000Z" },
        { itemId: "pleading", by: "second", at: "2026-11-24T01:00:00.000Z" },
      ],
    })
    expect(readiness.known).toBe(true)
    if (!readiness.known) return
    expect(readiness.items.find((entry) => entry.id === "pleading")?.actor).toEqual({
      by: "second",
      at: "2026-11-24T01:00:00.000Z",
    })
    expect(({} as { polluted?: string }).polluted).toBeUndefined()
  })
})

describe("flag and wiring seam", () => {
  it("exports D4_CHECKLIST and leaves it off unless the env value is true", () => {
    expect(D4_CHECKLIST_FLAG).toBe("D4_CHECKLIST")
    vi.stubEnv(`SIKANDER_FLAG_${D4_CHECKLIST_FLAG}`, "")
    expect(isD4ChecklistEnabled()).toBe(false)
    vi.stubEnv(`SIKANDER_FLAG_${D4_CHECKLIST_FLAG}`, "true")
    expect(isD4ChecklistEnabled()).toBe(true)
    vi.stubEnv(`SIKANDER_FLAG_${D4_CHECKLIST_FLAG}`, " TRUE ")
    expect(isD4ChecklistEnabled()).toBe(true)
    vi.stubEnv(`SIKANDER_FLAG_${D4_CHECKLIST_FLAG}`, "yes")
    expect(isD4ChecklistEnabled()).toBe(false)
    vi.stubEnv(`SIKANDER_FLAG_${D4_CHECKLIST_FLAG}`, "false")
    expect(isD4ChecklistEnabled()).toBe(false)
  })

  it("answers the pure checklist while the flag is unset", () => {
    vi.stubEnv(`SIKANDER_FLAG_${D4_CHECKLIST_FLAG}`, "")
    expect(isD4ChecklistEnabled()).toBe(false)
    expect(asKnown("civil_suit").documentTypeId).toBe("civil_suit")
  })

  it("is not referenced by the gate, the functions entrypoint or the router", () => {
    const files = ["functions/src/d4/gateOps.ts", "functions/src/index.ts", "functions/src/http/router.ts"]
    for (const file of files) {
      const source = readFileSync(path.join(root, file), "utf8")
      expect(source, file).not.toMatch(/blockIfIncomplete|getChecklistForType|getReadiness|D4_CHECKLIST|checklistProfiles/)
    }
  })
})
