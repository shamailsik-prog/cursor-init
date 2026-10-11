import { FieldValue, Timestamp, type DocumentReference } from "firebase-admin/firestore"
import type { Classification } from "@/platform/p1/types"
import { adminDb } from "../admin"
import { HttpError } from "../http/errors"
import type { Caller } from "../p5/auth"
import { isKnownClassification, rankOf } from "../p5/classification"
import type { CallAudit, Data, FirmOperation, FirmlessOperation } from "../p5/common"
import { requirePermission } from "../p5/permission"
import { THRESHOLDS, alertRef, budgetOf, firmConfigRef, monthRef, pkrRateOf, platformConfigRef, spentOf } from "./config"
import { PROVIDER_ID } from "./costTable"
import { callP1 } from "./gateway"
import { isMonthKey, monthKeyPkt } from "./month"
import { TRANSPORT_ERROR } from "./types"

/**
 * The five P1 operations behind `/api/platform/brain/` (spec P3-60, P3-66, P3-70..P3-72): `committeeBrain`,
 * `getAiUsage`, `setBudgetAlerts`, `setAiKillSwitch` (firm operations) and `setPlatformAiKillSwitch`
 * (firmless, `platformAdmin` claim). They are the HTTP face of `callP1` and of the server-only P1 documents
 * (`ai_config/{firmId}`, `platform/p1`, `ai_usage_months/*`, `ai_budget_alerts/*`); no client reads or
 * writes those directly (firestore.rules).
 */

/** The Next.js route's fixed purpose list (I1): the purpose travels to the provider, so it is never free text. */
const COMMITTEE_PURPOSES: ReadonlySet<string> = new Set(["committee-brain", "summarise", "research", "translate", "ops-audit"])
const DEFAULT_PURPOSE = "committee-brain"
/** Caller-authored free text is never rank 0: anyone can create a "public" matter (N1). */
const FREE_TEXT_FLOOR: Classification = "internal"
/** UTF-16 code units, like `String.length`. */
const MAX_BODY_CHARS = 100_000
const MAX_PARTY_NAMES = 50

const MAX_BUDGET_USD = 1_000_000
const MAX_PKR_PER_USD = 10_000
const MAX_DISABLED_MODELS = 20
const MAX_MODEL_ID_CHARS = 200
const MAX_REASON_CHARS = 500

const badRequest = (code: string) => new HttpError(400, code)

/** Attempts at the `committee_outputs` write; after a failed attempt the wait is 100 ms, then 200 ms (doubling). */
const OUTPUT_WRITE_ATTEMPTS = 3
const OUTPUT_WRITE_BACKOFF_MS = 100

/**
 * Test seam only; production code never sets it, and it is inert when `NODE_ENV` is "production".
 * `outputWriteFailures` is a queue: each attempt at the `committee_outputs` write takes the next error from it
 * and throws it instead of writing. `sleep` replaces the back-off wait.
 */
export const p1OpsTestSeam: { outputWriteFailures?: Error[]; sleep?: (ms: number) => Promise<void> } = {}

function seam(): typeof p1OpsTestSeam {
  return process.env.NODE_ENV === "production" ? {} : p1OpsTestSeam
}

/**
 * Runs `write` up to OUTPUT_WRITE_ATTEMPTS times. The provider call and its usage row are already committed
 * by then, so a transient failure of the output row's transaction is retried rather than lost; an HttpError
 * (e.g. 503 audit_unavailable) is a decision, not a transient fault, and is never retried. The last failure is
 * rethrown as it was.
 */
async function withOutputWriteRetry(write: () => Promise<void>): Promise<void> {
  const t = seam()
  for (let attempt = 1; ; attempt++) {
    try {
      const injected = t.outputWriteFailures?.shift()
      if (injected) throw injected
      return await write()
    } catch (err) {
      if (err instanceof HttpError || attempt >= OUTPUT_WRITE_ATTEMPTS) throw err
      const wait = OUTPUT_WRITE_BACKOFF_MS * 2 ** (attempt - 1)
      await (t.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(wait)
    }
  }
}

// ---------------------------------------------------------------------------
// committeeBrain
// ---------------------------------------------------------------------------

type CommitteeInput = {
  matterId: string
  body: string
  purpose: string
  classification: Classification | undefined
  partyNames: string[]
}

/** The request checks, in the order the spec states them; the first failure wins. */
function parseCommitteeInput(data: Data): CommitteeInput {
  const { matterId, body, purpose, classification, documentIds, partyNames } = data
  if (typeof matterId !== "string" || matterId === "") throw badRequest("matter_required")
  if (typeof body !== "string" || body === "" || body.length > MAX_BODY_CHARS) throw badRequest("invalid_body")
  if (purpose !== undefined && !(typeof purpose === "string" && COMMITTEE_PURPOSES.has(purpose))) throw badRequest("invalid_purpose")
  if (classification !== undefined && !isKnownClassification(classification)) throw badRequest("invalid_classification")
  // Documents are not in Cloud Functions yet: any presence of the field is refused.
  if (documentIds !== undefined) throw badRequest("documents_not_supported")
  if (
    partyNames !== undefined &&
    !(Array.isArray(partyNames) && partyNames.length <= MAX_PARTY_NAMES && partyNames.every((n) => typeof n === "string" && n.trim() !== ""))
  ) {
    throw badRequest("invalid_party_names")
  }
  return {
    matterId,
    body,
    purpose: purpose === undefined ? DEFAULT_PURPOSE : (purpose as string),
    classification: classification as Classification | undefined,
    partyNames: (partyNames as string[] | undefined) ?? [],
  }
}

/**
 * `ai.call` on the matter, with the same answer for an absent and another firm's matter as `getMatter`:
 * 404 `not_found`, so existence never leaks. Any other refusal is requirePermission's 403 (role_not_permitted,
 * not_member, clearance, ...); an audit failure is 503.
 */
async function gateAiCall(caller: Caller, matterId: string): Promise<void> {
  try {
    await requirePermission(caller, "ai.call", matterId)
  } catch (err) {
    if (err instanceof HttpError && err.status === 403 && err.code === "cross_firm") throw new HttpError(404, "not_found")
    throw err
  }
}

/** The strictest label by rank, never by string comparison. */
function strictest(labels: Classification[]): Classification {
  return labels.reduce((a, b) => (rankOf(b) > rankOf(a) ? b : a))
}

/**
 * Every `name` and `names` entry of this firm's `matter_parties` rows for the matter, plus the supplied names,
 * de-duplicated. Longest first, so "Ali Raza Khan" is masked whole before "Ali Raza" can leave "Khan" behind.
 */
async function partyNamesFor(firmId: string, matterId: string, supplied: string[]): Promise<string[]> {
  const rows = await adminDb().collection("matter_parties").where("firmId", "==", firmId).where("matterId", "==", matterId).get()
  const names = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim() !== "") names.add(value.trim())
  }
  for (const row of rows.docs) {
    const party = row.data()
    add(party.name)
    if (Array.isArray(party.names)) party.names.forEach(add)
  }
  supplied.forEach(add)
  return [...names].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
}

export type CommitteeBrainResponse = {
  outputId: string
  blocked: boolean
  reason?: string
  text?: string
  classification: Classification
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number }
  traceId: string
}

/**
 * committeeBrain({ matterId, body, purpose?, classification?, partyNames?, documentIds? }) (P3-70). Checks the
 * request, then `ai.call` on the matter (same firm, member, cleared; partner, associate, clerk), derives the
 * classification (the strictest of the matter's label, the caller's label and the `internal` floor; the caller's
 * clearance must reach it), masks with the matter's party names, calls `callP1` and writes one `committee_outputs`
 * row. A blocked or failed call is stored and returned like an ok one, with its reason and no text.
 */
export const committeeBrainOp: FirmOperation<CommitteeBrainResponse> = {
  auth: "firm",
  kind: "p1",
  action: "ai.call",
  target: "matters",
  run: async ({ caller, now: routerNow }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    const input = parseCommitteeInput(data)
    const { matterId } = input
    audit.target = `matters/${matterId}`
    await gateAiCall(caller, matterId)

    const matter = (await adminDb().collection("matters").doc(matterId).get()).data()
    if (!matter || matter.firmId !== caller.firmId) throw new HttpError(404, "not_found")
    // requirePermission refused an unreadable label already; this keeps the derivation fail-closed on its own.
    if (!isKnownClassification(matter.classification)) throw new HttpError(403, "clearance")
    const labels: Classification[] = [matter.classification, FREE_TEXT_FLOOR]
    if (input.classification !== undefined) labels.push(input.classification)
    const classification = strictest(labels)
    if (rankOf(caller.clearanceLevel) < rankOf(classification)) throw new HttpError(403, "clearance")

    const partyNames = await partyNamesFor(caller.firmId, matterId, input.partyNames)
    // The router's clock for the month and the trace id, plus real elapsed time so the trace has a duration.
    const t0 = Date.now()
    const clock = () => (routerNow ?? t0) + (Date.now() - t0)
    const result = await callP1(
      { firmId: caller.firmId, actorId: caller.uid, matterId, jobId: null, taskType: "committee", classification, body: input.body, purpose: input.purpose, partyNames },
      { now: clock }
    )

    const blocked = result.outcome !== "ok"
    const reason = result.blockReason ?? (result.outcome === "failed" ? TRANSPORT_ERROR : undefined)
    const outputRef = adminDb().collection("committee_outputs").doc()
    // The Next.js row shape (CommitteeBrainOutput): `id` in the row, `createdAt` in epoch milliseconds from the op's clock.
    const createdAt = Math.floor(clock())
    await withOutputWriteRetry(() => adminDb().runTransaction(async (tx) => {
      await audit.stage(tx, "allow", "ok")
      tx.create(outputRef, {
        id: outputRef.id,
        firmId: caller.firmId,
        actorId: caller.uid,
        matterId,
        documentIds: [],
        classification,
        purpose: input.purpose,
        blocked,
        ...(reason === undefined ? {} : { reason }),
        ...(result.outcome === "ok" ? { text: result.text } : {}),
        outbound: {
          body: result.outbound.body,
          metadata: { classification, provider: PROVIDER_ID, purpose: result.outbound.purpose, redactionCounts: result.outbound.redactionCounts },
        },
        usageLogId: result.usageLogId,
        traceId: result.traceId,
        createdAt,
      })
    }))
    audit.committed()

    return {
      outputId: outputRef.id,
      blocked,
      ...(reason === undefined ? {} : { reason }),
      ...(result.outcome === "ok" ? { text: result.text } : {}),
      classification,
      usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costMicroUsd: result.costMicroUsd },
      traceId: result.traceId,
    }
  },
}

// ---------------------------------------------------------------------------
// getAiUsage
// ---------------------------------------------------------------------------

/** A stored kill switch as the partner sees it. `setAt` is null only for a malformed stored doc. */
export type KillSwitchView = { disableAll: boolean; disabledModels: string[]; reason: string; setBy: string; setAt: string | null }

export type AiUsageResponse = {
  month: string
  budgetMicroUsd: number | null
  spentMicroUsd: number
  spentPkr: number | null
  pkrPerUsd: number | null
  percentUsed: number | null
  calls: { ok: number; failed: number; blocked: number }
  inputTokens: number
  outputTokens: number
  alerts: Array<{ threshold: number; at: string }>
  killSwitch: { firm: KillSwitchView | null; platform: KillSwitchView | null }
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)
const isoOf = (value: unknown): string | null => (value instanceof Timestamp ? value.toDate().toISOString() : null)

/** What the switch enforces (`killSwitchBlocks` in config.ts: only `disableAll === true` and exact model ids count). */
function killSwitchView(raw: unknown, setBy?: string): KillSwitchView | null {
  if (raw === null || typeof raw !== "object") return null
  const ks = raw as Record<string, unknown>
  return {
    disableAll: ks.disableAll === true,
    disabledModels: Array.isArray(ks.disabledModels) ? ks.disabledModels.filter((m): m is string => typeof m === "string") : [],
    reason: typeof ks.reason === "string" ? ks.reason : "",
    setBy: setBy ?? (typeof ks.setBy === "string" ? ks.setBy : ""),
    setAt: isoOf(ks.setAt),
  }
}

/** What a firm's partner is told of who set the platform switch: never the operator's uid. */
const PLATFORM_SETTER = "platform"

/**
 * getAiUsage(?month=YYYY-MM) (P3-71), partner only (`ai.usage.read`). Reads the month total, the firm's config,
 * the platform doc and the two alert docs; never the logs. PKR and percent are rounded to 2 decimal places from
 * integer micro-USD.
 */
export const getAiUsageOp: FirmOperation<AiUsageResponse> = {
  auth: "firm",
  kind: "general",
  action: "ai.usage.read",
  target: "ai_usage_months",
  run: async ({ caller, now }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `firms/${caller.firmId}`
    await requirePermission(caller, "ai.usage.read")
    if (data.month !== undefined && !isMonthKey(data.month)) throw badRequest("invalid_month")
    const month = data.month === undefined ? monthKeyPkt(now ?? Date.now()) : (data.month as string)
    audit.target = `ai_usage_months/${caller.firmId}_${month}`

    const [total, config, platform, ...alertSnaps] = await adminDb().getAll(
      monthRef(caller.firmId, month),
      firmConfigRef(caller.firmId),
      platformConfigRef(),
      ...THRESHOLDS.map((t) => alertRef(caller.firmId, month, t))
    )
    await audit.allow()

    const spent = spentOf(total.data())
    const budget = budgetOf(config.data())
    const rate = pkrRateOf(config.data())
    return {
      month,
      budgetMicroUsd: budget,
      spentMicroUsd: spent,
      spentPkr: rate === null ? null : Math.round((spent * rate) / 10_000) / 100,
      pkrPerUsd: rate,
      percentUsed: budget === null ? null : Math.round((spent * 10_000) / budget) / 100,
      calls: { ok: count(total.get("calls.ok")), failed: count(total.get("calls.failed")), blocked: count(total.get("calls.blocked")) },
      inputTokens: count(total.get("inputTokens")),
      outputTokens: count(total.get("outputTokens")),
      alerts: alertSnaps.flatMap((snap, i) => {
        const at = snap.exists ? isoOf(snap.get("createdAt")) ?? isoOf(snap.createTime) : null
        return at === null ? [] : [{ threshold: THRESHOLDS[i]!, at }]
      }),
      killSwitch: { firm: killSwitchView(config.get("killSwitch")), platform: killSwitchView(platform.get("killSwitch"), PLATFORM_SETTER) },
    }
  },
}

// ---------------------------------------------------------------------------
// setBudgetAlerts
// ---------------------------------------------------------------------------

/**
 * Micro-USD from a budget in USD: a number above 0 and at most 1,000,000 with at most 2 decimal places. The
 * decimal places are read off the number's shortest round-trip string (`String(1.001)` is "1.001", float noise
 * such as 0.1 + 0.2 is "0.30000000000000004", and an exponent form such as "1e-7" never matches), so there is no
 * epsilon: 1.5 and 0.01 pass, 1.001 does not.
 */
function parseBudgetUsd(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_BUDGET_USD) throw badRequest("invalid_budget")
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw badRequest("invalid_budget")
  return Math.round(value * 1_000_000)
}

function parsePkrPerUsd(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_PKR_PER_USD) throw badRequest("invalid_rate")
  return value
}

/**
 * setBudgetAlerts({ monthlyBudgetUsd, pkrPerUsd? }) (P3-71), partner only (`ai.budget.set`). Stores the budget as
 * integer micro-USD, and the rate when given (omitted leaves an existing rate untouched), merged into
 * `ai_config/{firmId}`. The alert thresholds are fixed at 70 and 90 (P3-65).
 */
export const setBudgetAlertsOp: FirmOperation<{ monthlyBudgetMicroUsd: number; pkrPerUsd: number | null }> = {
  auth: "firm",
  kind: "general",
  action: "ai.budget.set",
  target: "ai_config",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `ai_config/${caller.firmId}`
    await requirePermission(caller, "ai.budget.set")
    const monthlyBudgetMicroUsd = parseBudgetUsd(data.monthlyBudgetUsd)
    const pkrPerUsd = data.pkrPerUsd === undefined ? undefined : parsePkrPerUsd(data.pkrPerUsd)

    const ref = firmConfigRef(caller.firmId)
    const effectiveRate = await adminDb().runTransaction(async (tx) => {
      const existing = (await tx.get(ref)).data()
      await audit.stage(tx, "allow", "ok")
      tx.set(ref, { monthlyBudgetMicroUsd, ...(pkrPerUsd === undefined ? {} : { pkrPerUsd }) }, { merge: true })
      return pkrPerUsd ?? pkrRateOf(existing)
    })
    audit.committed()
    return { monthlyBudgetMicroUsd, pkrPerUsd: effectiveRate }
  },
}

// ---------------------------------------------------------------------------
// setAiKillSwitch, setPlatformAiKillSwitch
// ---------------------------------------------------------------------------

type KillSwitchInput = { disableAll: boolean; disabledModels: string[]; reason: string }
type KillSwitchSet = KillSwitchInput & { setBy: string }

/** `{ disableAll: boolean, disabledModels: string[], reason }`: the shape first (`invalid_kill_switch`), then the reason (`invalid_reason`). */
function parseKillSwitch(data: Data): KillSwitchInput {
  const { disableAll, disabledModels, reason } = data
  if (typeof disableAll !== "boolean") throw badRequest("invalid_kill_switch")
  if (
    !Array.isArray(disabledModels) ||
    disabledModels.length > MAX_DISABLED_MODELS ||
    !disabledModels.every((m) => typeof m === "string" && m !== "" && m.length <= MAX_MODEL_ID_CHARS)
  ) {
    throw badRequest("invalid_kill_switch")
  }
  const trimmed = typeof reason === "string" ? reason.trim() : ""
  if (trimmed === "" || trimmed.length > MAX_REASON_CHARS) throw badRequest("invalid_reason")
  return { disableAll, disabledModels: [...(disabledModels as string[])], reason: trimmed }
}

/** Replaces the whole `killSwitch` field of `ref` (and only that field) with the request, in one transaction with the call's audit row. */
async function storeKillSwitch(ref: DocumentReference, input: KillSwitchInput, uid: string, audit: CallAudit): Promise<KillSwitchSet> {
  await adminDb().runTransaction(async (tx) => {
    await audit.stage(tx, "allow", "ok")
    tx.set(ref, { killSwitch: { ...input, setBy: uid, setAt: FieldValue.serverTimestamp() } }, { mergeFields: ["killSwitch"] })
  })
  audit.committed()
  return { ...input, setBy: uid }
}

/**
 * setAiKillSwitch({ disableAll, disabledModels, reason }) (P3-66), partner only (`ai.kill_switch.set`). A request
 * replaces the firm's whole switch in `ai_config/{firmId}.killSwitch`; `{ disableAll: false, disabledModels: [] }`
 * re-enables. P1 reads it fresh on every call, so it takes effect on the next call.
 */
export const setAiKillSwitchOp: FirmOperation<KillSwitchSet> = {
  auth: "firm",
  kind: "general",
  action: "ai.kill_switch.set",
  target: "ai_config",
  run: async ({ caller }, data, audit) => {
    audit.firmId = caller.firmId
    audit.target = `ai_config/${caller.firmId}`
    await requirePermission(caller, "ai.kill_switch.set")
    const input = parseKillSwitch(data)
    return storeKillSwitch(firmConfigRef(caller.firmId), input, caller.uid, audit)
  },
}

/**
 * setPlatformAiKillSwitch({ disableAll, disabledModels, reason }) (P3-66): the operator's switch across every
 * firm, stored at `platform/p1.killSwitch`. Platform admin only (`platformAdmin: true` in the caller's current
 * custom claims; 403 platform_admin_only otherwise), checked before the body. Firmless, like recordGatePass.
 */
export const setPlatformAiKillSwitchOp: FirmlessOperation<KillSwitchSet> = {
  auth: "firmless",
  kind: "general",
  action: "ai.platform_kill_switch.set",
  target: "platform/p1",
  run: async ({ uid, claims }, data, audit) => {
    if (claims.platformAdmin !== true) throw new HttpError(403, "platform_admin_only")
    const input = parseKillSwitch(data)
    return storeKillSwitch(platformConfigRef(), input, uid, audit)
  },
}
