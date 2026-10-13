import { Timestamp, type DocumentData } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { DraftCharsetError, requireSupportedDraftBody } from "@/services/d4-2/draftCharset"
import { adminDb } from "../admin"
import { isContentionAbort } from "../d1/contention"
import { HttpError } from "../http/errors"
import type { P1Result } from "../p1/gateway"
import type { Caller } from "../p5/auth"
import type { Data, FirmOperation } from "../p5/common"
import { getDocumentType } from "./doctypes"
import { iso, parseVersionNumber, parseVersionParam, requireStillPermitted, withinClearance } from "./drafts"
import { OUTLINE_PURPOSE, PROMPT_VERSION, outlinePrompt } from "./generationPrompt"
import { callDrafting, claimLease, d4Now, outcomeOf, releaseLease, verbatimOf, writeDeadline, writeOutcome, type StepResult } from "./generationRun"
import { generationLabel, liveLease, loadGenerationForCaller, outlineId, outlines, parseGenerationId, refuseReservedTokens, type Stage } from "./generations"
import { advocateText, checkOutlineAnswer, outlineSha256, validOutline, type Guarded, type OutlineContent } from "./guardrails"
import { activeTemplateStore, deterministicFirstCheck } from "./templates"

/**
 * The outline steps of draft generation (spec P4B-1, P4B-9, P4B-10, P4B-12, P4B-14, P4B-17): `generateOutline` (one P1
 * call that proposes a strategy outline), `approveOutline` (the advocate binds the approval to one outline version and
 * its hash, optionally storing an edit) and `getOutline` (the outline's text, for the advocate to read before
 * approving). A POST answers ids, stage, outcome, usage and cost, never text (P4B-14): the text is read through
 * `getOutline`.
 */

/** What generateOutline answers. */
export type OutlineStepResult = StepResult & { step: "outline" }

/** An outline as getOutline returns it: the stored outline's fields without `firmId` and `matterId`, plus `approved`. */
export type OutlineView = {
  generationId: string
  version: number
  kind: "generated" | "edited"
  sections: OutlineContent["sections"]
  missingFacts: OutlineContent["missingFacts"]
  sha256: string
  classification: Classification
  editedFrom: number | null
  path: string | null
  model: string | null
  promptVersion: string | null
  traceId: string | null
  inputTokens: number
  outputTokens: number
  costMicroUsd: number
  usageLogId: string | null
  createdBy: string
  createdAt: string | null
  approved: boolean
}

export type ApproveOutlineResult = { generationId: string; stage: Stage; outlineVersion: number; outlineSha256: string; sectionCount: number }

const matters = () => adminDb().collection("matters")
const badRequest = (code: string) => new HttpError(400, code)
const NO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, costMicroUsd: 0 })
/** The most acknowledgements: one per missing fact, and an outline has at most 50. */
const MAX_ACKNOWLEDGEMENTS = 50

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** `baseOutlineVersion`: a JSON integer from 0 up (400 `invalid_version`). */
function parseBaseVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw badRequest("invalid_version")
  return value
}

/** `outlineSha256`: 64 lowercase hex characters (400 `invalid_outline_hash`). */
function parseOutlineHash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw badRequest("invalid_outline_hash")
  return value
}

/** `outline`: absent, or an outline within D11's shape and the limits, its strings trimmed (400 `invalid_outline`). */
function parseEdit(value: unknown): OutlineContent | undefined {
  if (value === undefined) return undefined
  const outline = validOutline(value)
  if (outline === null) throw badRequest("invalid_outline")
  return outline
}

/** `acknowledgedMissingFacts`: distinct integers from 0 to 49, returned in ascending order (400 `invalid_acknowledgement`). */
function parseAcknowledgement(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > MAX_ACKNOWLEDGEMENTS) throw badRequest("invalid_acknowledgement")
  const seen = new Set<number>()
  for (const n of value as unknown[]) {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n >= MAX_ACKNOWLEDGEMENTS || seen.has(n)) throw badRequest("invalid_acknowledgement")
    seen.add(n)
  }
  return [...seen].sort((a, b) => a - b)
}

/** Step 3 of both outline POSTs: the brief's matter, read now; a closed one takes no step (409 `matter_closed`, D6). */
async function refuseClosedMatter(caller: Caller, brief: DocumentData): Promise<void> {
  const matter = (await matters().doc(brief.matterId as string).get()).data()
  if (!matter || matter.firmId !== caller.firmId) throw new HttpError(404, "not_found")
  if (matter.status === "closed") throw new HttpError(409, "matter_closed")
}

/** The stored outline `version` of the generation, or null. */
async function storedOutline(caller: Caller, generationId: string, version: number): Promise<DocumentData | null> {
  const d = (await outlines().doc(outlineId(generationId, version)).get()).data()
  return d !== undefined && d.firmId === caller.firmId && d.generationId === generationId ? d : null
}

/** The outline content of a stored outline, named fields only. */
function contentOf(d: DocumentData): OutlineContent {
  return {
    sections: (d.sections as OutlineContent["sections"]).map((s) => ({ heading: s.heading, purpose: s.purpose })),
    missingFacts: (d.missingFacts as OutlineContent["missingFacts"]).map((m) => ({ field: m.field, note: m.note })),
  }
}

// ---------------------------------------------------------------------------
// generateOutline
// ---------------------------------------------------------------------------

/**
 * generateOutline({ generationId, baseOutlineVersion }) → OutlineStepResult (P4B-1, P4B-14), in the 13-step order of
 * the P1 routes; the first refusal wins:
 *  1. the request (400: `invalid_generation_id`, `invalid_version`);
 *  2. the brief and `draft.generate` on its matter (404, 403);
 *  3. a closed matter (409 `matter_closed`);
 *  4. a stored generated outline `base + 1` (D3) is returned with `called: false`, no usage and no P1 call;
 *  5. an assembled generation (409 `generation_closed`);
 *  6. `baseOutlineVersion` that is not the brief's current version (409 `outline_changed`; an edited `base + 1` lands here);
 *  7. a live lease (409 `generation_in_progress`);
 *  8. the deterministic-first check: a template found is 501 `deterministic_not_built`, with no call and no write;
 *  9. the lease (`claimLease`, which judges 3, 5, 6 and 7 again, within the pre-call budget);
 *  10. the call; 11. the guardrails; 12. the outcome write, which stores outline `base + 1` (kind `generated`) on
 *  acceptance and makes the stage `outlined`, voiding any approval.
 * A throw between the lease and the outcome write releases the lease and is rethrown (D27). A call that reached P1
 * answers 200 with its outcome, as committeeBrain does: `stored`, `blocked`, `failed` or `refused`.
 */
export const generateOutlineOp: FirmOperation<OutlineStepResult> = {
  auth: "firm",
  kind: "p1",
  action: "draft.generate",
  target: "draft_generations",
  run: async ({ caller, now: routerNow }, data: Data, audit) => {
    // D23: both budgets run from here, on the op's own clock.
    const startedMs = d4Now()
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const generationId = parseGenerationId(data.generationId)
    const base = parseBaseVersion(data.baseOutlineVersion)
    audit.target = `draft_generations/${generationId}`
    const { ref, brief } = await loadGenerationForCaller(caller, generationId, "draft.generate")
    await refuseClosedMatter(caller, brief)
    const version = base + 1

    const done = await storedOutline(caller, generationId, version)
    if (done !== null && done.kind === "generated") {
      await audit.allow()
      return {
        generationId,
        stage: brief.stage as Stage,
        step: "outline",
        outlineVersion: version,
        called: false,
        outcome: "stored",
        reason: null,
        path: (done.path as string | null | undefined) ?? null,
        model: (done.model as string | null | undefined) ?? null,
        usage: { ...NO_USAGE },
        usageLogId: null,
        traceId: null,
      }
    }

    const recheck = (b: DocumentData) => {
      if (b.stage === "assembled") throw new HttpError(409, "generation_closed")
      if (b.outlineVersion !== base) throw new HttpError(409, "outline_changed")
    }
    recheck(brief)
    if (liveLease(brief, d4Now())) throw new HttpError(409, "generation_in_progress")
    if ((await deterministicFirstCheck(activeTemplateStore(), brief.documentTypeId as string, brief.templateId as string)) === "deterministic") {
      throw new HttpError(501, "deterministic_not_built")
    }

    const claim = await claimLease(caller, ref, { step: "outline", outlineVersion: version, section: null }, recheck, startedMs)
    let result: P1Result
    let guard: Guarded<OutlineContent> | null
    let verdict: ReturnType<typeof outcomeOf>
    let deadlineMs: number
    try {
      const b = claim.brief
      const type = getDocumentType(b.documentTypeId as string)
      if (type === null) throw new HttpError(404, "document_type_not_found")
      const verbatim = verbatimOf(b)
      const prompt = outlinePrompt({ type, verbatim, facts: b.facts as string })
      result = await callDrafting(caller, claim, OUTLINE_PURPOSE, prompt, routerNow)
      deadlineMs = writeDeadline()
      guard =
        result.outcome === "ok"
          ? checkOutlineAnswer({ text: result.text ?? "", truncated: result.truncated, pseudonyms: result.pseudonyms }, advocateText({ title: b.title as string, facts: b.facts as string, verbatim }))
          : null
      verdict = outcomeOf(result, guard)
    } catch (err) {
      await releaseLease(ref, claim.claimId)
      throw err
    }

    const accepted = guard !== null && guard.ok ? guard.value : null
    const written = await writeOutcome({
      caller,
      audit,
      ref,
      claim,
      result,
      verdict,
      step: "outline",
      outlineVersion: version,
      section: null,
      deadlineMs,
      onStored: (tx, b, label, at) => {
        const content = accepted!
        tx.create(outlines().doc(outlineId(generationId, version)), {
          firmId: b.firmId,
          matterId: b.matterId,
          generationId,
          version,
          kind: "generated",
          sections: content.sections,
          missingFacts: content.missingFacts,
          sha256: outlineSha256(content),
          classification: label,
          editedFrom: null,
          path: "ai",
          model: result.model,
          promptVersion: PROMPT_VERSION,
          traceId: result.traceId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costMicroUsd: result.costMicroUsd,
          usageLogId: result.usageLogId,
          createdBy: caller.uid,
          createdAt: at,
        })
        return { outlineVersion: version, stage: "outlined" as Stage, approvedOutline: null, sectionCount: null, sectionsStored: 0 }
      },
    })
    return {
      generationId,
      stage: written.stage as Stage,
      step: "outline",
      outlineVersion: written.outlineVersion as number,
      called: true,
      outcome: verdict.outcome,
      reason: verdict.reason,
      path: "ai",
      model: result.model,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costMicroUsd: result.costMicroUsd },
      usageLogId: result.usageLogId,
      traceId: result.traceId,
    }
  },
}

// ---------------------------------------------------------------------------
// approveOutline
// ---------------------------------------------------------------------------

/** The approval's state checks, in order (D6): an assembled generation, no outline yet, another current version. */
function refuseApprovalState(brief: DocumentData, version: number): void {
  if (brief.stage === "assembled") throw new HttpError(409, "generation_closed")
  if (typeof brief.outlineVersion !== "number" || brief.outlineVersion < 1) throw new HttpError(404, "outline_not_found")
  if (brief.outlineVersion !== version) throw new HttpError(409, "outline_changed")
}

/** The stored current outline the approval names, or 404 `outline_not_found`; a hash that is not its hash is 409 `outline_changed`. */
function refuseOutline(stored: DocumentData | null | undefined, caller: Caller, sha: string): DocumentData {
  if (!stored || stored.firmId !== caller.firmId) throw new HttpError(404, "outline_not_found")
  if (stored.sha256 !== sha) throw new HttpError(409, "outline_changed")
  return stored
}

/**
 * The edit's text rules, after the permission (no oracle): each string passes the charset rule (422
 * `unsupported_characters`) and is kept in its normalised form; the outline is judged against its limits again on
 * those strings (a string that is nothing, or over its limit, once normalised is 422 `unsupported_characters`); then
 * no string holds a reserved token (422 `reserved_tokens`, D26).
 */
function checkedEdit(edit: OutlineContent): OutlineContent {
  const normal = (s: string): string => {
    try {
      return requireSupportedDraftBody(s)
    } catch (err) {
      if (err instanceof DraftCharsetError) throw new HttpError(422, err.code)
      throw err
    }
  }
  const outline = validOutline({
    sections: edit.sections.map((s) => ({ heading: normal(s.heading), purpose: normal(s.purpose) })),
    missingFacts: edit.missingFacts.map((m) => ({ field: normal(m.field), note: normal(m.note) })),
  })
  if (outline === null) throw new HttpError(422, "unsupported_characters")
  refuseReservedTokens([...outline.sections.flatMap((s) => [s.heading, s.purpose]), ...outline.missingFacts.flatMap((m) => [m.field, m.note])])
  return outline
}

/** D7: the acknowledgement is exactly every missing fact of the outline approved, `0` to `m − 1` (422 `missing_facts_not_acknowledged`). */
function requireAcknowledged(acknowledged: readonly number[], missingFacts: number): void {
  if (acknowledged.length !== missingFacts || acknowledged.some((n) => n >= missingFacts)) throw new HttpError(422, "missing_facts_not_acknowledged")
}

/**
 * approveOutline({ generationId, outlineVersion, outlineSha256, outline?, acknowledgedMissingFacts }) →
 * `{ generationId, stage, outlineVersion, outlineSha256, sectionCount }` (P4B-10). The 400 checks in field order; then
 * `draft.outline.approve` on the brief's matter (a partner or an associate who is a member; a clerk is 403
 * `role_not_permitted`); then, in order: a closed matter (409 `matter_closed`), an assembled generation (409
 * `generation_closed`), no outline (404 `outline_not_found`), a version or hash that is not the stored current outline's
 * (409 `outline_changed`), a live lease (409 `generation_in_progress`), the edit's text rules (422), and the
 * acknowledgement of every missing fact (422, D7). One transaction judges all of these again under
 * `requireStillPermitted` and stages the audit row, then:
 * - an edit (D6) whose hash differs from the current outline's is stored as version n + 1 (kind `edited`, D8: no path,
 *   model, prompt version or trace, no usage, the source's `usageLogId`) and approved;
 * - no edit (or an edit equal to the current outline) of a version already approved under the same hash writes only
 *   the audit row;
 * - otherwise the version is approved: `approvedOutline`, stage `approved`, `sectionCount`, `sectionsStored: 0`.
 * A later run of the transaction (the SDK's retry) that finds this caller's approval of the intended version and hash
 * already recorded answers as the committed run did and writes nothing: that run's answer was lost.
 */
export const approveOutlineOp: FirmOperation<ApproveOutlineResult> = {
  auth: "firm",
  kind: "general",
  action: "draft.outline.approve",
  target: "draft_generations",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const generationId = parseGenerationId(data.generationId)
    const version = parseVersionNumber(data.outlineVersion)
    const sha = parseOutlineHash(data.outlineSha256)
    const edit = parseEdit(data.outline)
    const acknowledged = parseAcknowledgement(data.acknowledgedMissingFacts)
    audit.target = `draft_generations/${generationId}`
    const { ref, brief } = await loadGenerationForCaller(caller, generationId, "draft.outline.approve")

    await refuseClosedMatter(caller, brief)
    refuseApprovalState(brief, version)
    const current = refuseOutline(await storedOutline(caller, generationId, version), caller, sha)
    if (liveLease(brief, d4Now())) throw new HttpError(409, "generation_in_progress")
    const checked = edit === undefined ? undefined : checkedEdit(edit)
    // D6: an edit whose hash is the current outline's is no edit.
    const changed = checked !== undefined && outlineSha256(checked) !== sha ? checked : undefined
    const approved = changed ?? contentOf(current)
    requireAcknowledged(acknowledged, approved.missingFacts.length)

    // What this request records: the edit's version and hash, or the named version's.
    const intended =
      changed !== undefined
        ? { version: version + 1, sha256: outlineSha256(changed), sectionCount: changed.sections.length }
        : { version, sha256: sha, sectionCount: (current.sections as unknown[]).length }
    let runs = 0
    let out: ApproveOutlineResult
    try {
      out = await adminDb().runTransaction(async (tx) => {
        runs += 1
        // The stamp is taken in the attempt that commits.
        const stamp = Timestamp.now()
        const b = (await tx.get(ref)).data()
        if (!b || b.firmId !== caller.firmId || !withinClearance(b.classification, caller.clearanceLevel)) throw new HttpError(404, "not_found")
        // A later run of this transaction that finds this caller's approval of the intended version and hash: an earlier
        // run committed it, with the audit row, and its answer was lost. Answer as that run did; write nothing again.
        const recorded = b.approvedOutline as { version?: unknown; sha256?: unknown; by?: unknown } | null | undefined
        if (runs > 1 && recorded?.version === intended.version && recorded.sha256 === intended.sha256 && recorded.by === caller.uid) {
          return { generationId, stage: b.stage as Stage, outlineVersion: intended.version, outlineSha256: intended.sha256, sectionCount: intended.sectionCount }
        }
        const matter = await requireStillPermitted(tx, caller, "draft.outline.approve", b.matterId as string)
        if (matter.status === "closed") throw new HttpError(409, "matter_closed")
        refuseApprovalState(b, version)
        // Outlines are immutable, so the hash read here pins the content judged above.
        refuseOutline((await tx.get(outlines().doc(outlineId(generationId, version)))).data(), caller, sha)
        if (liveLease(b, d4Now())) throw new HttpError(409, "generation_in_progress")
        const label = generationLabel(caller, b, matter)
        await audit.stage(tx, "allow", "ok")

        const approval = (v: number, sha256: string) => ({ version: v, sha256, by: caller.uid, at: stamp, acknowledgedMissingFacts: acknowledged })
        if (changed !== undefined) {
          const next = intended.version
          const nextSha = intended.sha256
          tx.create(outlines().doc(outlineId(generationId, next)), {
            firmId: b.firmId,
            matterId: b.matterId,
            generationId,
            version: next,
            kind: "edited",
            sections: changed.sections,
            missingFacts: changed.missingFacts,
            sha256: nextSha,
            classification: label,
            editedFrom: version,
            path: null,
            model: null,
            promptVersion: null,
            traceId: null,
            inputTokens: 0,
            outputTokens: 0,
            costMicroUsd: 0,
            usageLogId: current.usageLogId ?? null,
            createdBy: caller.uid,
            createdAt: stamp,
          })
          tx.update(ref, {
            outlineVersion: next,
            stage: "approved" as Stage,
            approvedOutline: approval(next, nextSha),
            sectionCount: changed.sections.length,
            sectionsStored: 0,
            classification: label,
            updatedAt: stamp,
          })
          return { generationId, stage: "approved" as Stage, outlineVersion: next, outlineSha256: nextSha, sectionCount: changed.sections.length }
        }
        const sectionCount = intended.sectionCount
        const already = b.approvedOutline as { version?: unknown; sha256?: unknown } | null | undefined
        if (already?.version === version && already.sha256 === sha) {
          return { generationId, stage: b.stage as Stage, outlineVersion: version, outlineSha256: sha, sectionCount }
        }
        tx.update(ref, { stage: "approved" as Stage, approvedOutline: approval(version, sha), sectionCount, sectionsStored: 0, classification: label, updatedAt: stamp })
        return { generationId, stage: "approved" as Stage, outlineVersion: version, outlineSha256: sha, sectionCount }
      })
    } catch (err) {
      // The attempts ran out against another writer on this brief: nothing was written.
      if (isContentionAbort(err)) throw new HttpError(503, "generation_busy")
      throw err
    }
    audit.committed()
    return out
  },
}

// ---------------------------------------------------------------------------
// getOutline
// ---------------------------------------------------------------------------

/** A stored outline as getOutline returns it: named fields only, times as ISO strings, and whether it is the approved one. */
export function outlineView(generationId: string, d: DocumentData, brief: DocumentData): OutlineView {
  const approved = brief.approvedOutline as { version?: unknown; sha256?: unknown } | null | undefined
  const content = contentOf(d)
  return {
    generationId,
    version: d.version,
    kind: d.kind,
    sections: content.sections,
    missingFacts: content.missingFacts,
    sha256: d.sha256,
    classification: d.classification,
    editedFrom: d.editedFrom ?? null,
    path: d.path ?? null,
    model: d.model ?? null,
    promptVersion: d.promptVersion ?? null,
    traceId: d.traceId ?? null,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    costMicroUsd: d.costMicroUsd,
    usageLogId: d.usageLogId ?? null,
    createdBy: d.createdBy,
    createdAt: iso(d.createdAt),
    approved: approved !== null && approved !== undefined && approved.version === d.version && approved.sha256 === d.sha256,
  }
}

/**
 * getOutline(?generationId=&version=) → OutlineView (P4B-1): the requested version (default: the current one), with
 * `approved` true when the brief's approval names this version and its hash. `draft.read` on the brief's matter; a
 * version the generation does not have, or a current version of 0, is 404 `outline_not_found`; a malformed version is
 * 400 `invalid_version` (1 to 9 digits, no leading zero, as 4a's).
 */
export const getOutlineOp: FirmOperation<OutlineView> = {
  auth: "firm",
  kind: "general",
  action: "draft.read",
  target: "draft_generations",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const generationId = parseGenerationId(data.generationId)
    const requested = data.version === undefined ? undefined : parseVersionParam(data.version)
    audit.target = `draft_generations/${generationId}`
    const { brief } = await loadGenerationForCaller(caller, generationId, "draft.read")
    const version = requested ?? brief.outlineVersion
    if (typeof version !== "number" || version < 1) throw new HttpError(404, "outline_not_found")
    const d = await storedOutline(caller, generationId, version)
    if (d === null || !withinClearance(d.classification, caller.clearanceLevel)) throw new HttpError(404, "outline_not_found")
    await audit.allow()
    return outlineView(generationId, d, brief)
  },
}
