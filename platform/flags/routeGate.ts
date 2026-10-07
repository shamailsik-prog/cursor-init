/**
 * Route-level freeze for a disabled layer (Erratum E-24; L18 §9.1 rule 4).
 *
 *   // in a route file, for each exported HTTP method:
 *   const handleGetGated = gateByFlag("LEGACY_GOVERNANCE_CHAINS", handleGet)
 *   //   ... return withSession(request, handleGetGated)
 *
 * The gate sits immediately inside `withSession`, so a frozen route is
 * authenticated and identity-bound exactly like a live one: an anonymous or
 * mismatched caller gets the same 401/403 as anywhere else and cannot use the
 * 404 to probe which layers exist. An authenticated call into a disabled layer
 * gets 404 `{ error: "feature_disabled", flag }` (no data, no handler code run)
 * and is recorded in the audit log as `feature_disabled` (deduped, see below). Nothing is deleted:
 * the handler and its data are untouched and come back when the flag is on.
 */
import type { HandlerSession, RouteHandler } from "@/platform/http/withSession"
import { getRuntimeRepositories } from "@/platform/persistence/runtimeRepositories"
import { getRuntimeStore } from "@/platform/spine/runtimeStore"
import { featureDisabledResponse, isFeatureEnabled, type FeatureFlag } from "@/platform/flags/featureFlags"

/** Says whether a request belongs to the core that stays live while the flag is off. */
export type CoreRequestPredicate = (request: Request) => boolean | Promise<boolean>

/**
 * Refusal audit dedupe: at most one `feature_disabled` row per (firm, user, method + path, flag)
 * per REFUSAL_AUDIT_TTL_MS, so a client polling a frozen route cannot grow the audit log without
 * bound. In-memory and per process (a cold start or another instance may write one more row);
 * expired keys are swept on insert once the map passes REFUSAL_AUDIT_SWEEP_AT entries.
 *
 * Final audit F5: the entry holds the covering write itself. A refusal deduped while that write
 * is in flight awaits it, and if it fails writes its own row (failing the request if that fails
 * too), so no refusal is answered without a durable row covering it.
 */
const REFUSAL_AUDIT_TTL_MS = 60_000
const REFUSAL_AUDIT_SWEEP_AT = 1_000
type RefusalAudit = { until: number; write: Promise<void> }
const recentRefusals = new Map<string, RefusalAudit>()

export function resetRefusalAuditDedupeForTests(): void {
  recentRefusals.clear()
}

async function writeRefusalRow(session: HandlerSession, target: string, flag: FeatureFlag, now: number) {
  const store = getRuntimeStore()
  const repos = await getRuntimeRepositories(store)
  await repos.audit.append({
    id: store.id("aud"),
    firmId: session.firmId,
    action: "feature_disabled",
    actorId: session.userId,
    target,
    classification: "internal",
    reason: flag,
    at: now,
  })
}

async function auditRefusal(request: Request, session: HandlerSession, flag: FeatureFlag) {
  const target = `${request.method.toUpperCase()} ${new URL(request.url).pathname}`
  const now = Date.now()
  const key = `${session.firmId}|${session.userId}|${target}|${flag}`
  const covering = recentRefusals.get(key)
  if (covering && covering.until > now) {
    try {
      await covering.write
      return
    } catch {
      // The covering write failed: this refusal writes its own row below.
    }
  }
  if (recentRefusals.size >= REFUSAL_AUDIT_SWEEP_AT) {
    for (const [k, entry] of recentRefusals) if (entry.until <= now) recentRefusals.delete(k)
  }
  const entry: RefusalAudit = { until: now + REFUSAL_AUDIT_TTL_MS, write: writeRefusalRow(session, target, flag, now) }
  // Claimed before the write completes, so concurrent refusals wait on this one write.
  recentRefusals.set(key, entry)
  try {
    await entry.write
  } catch (error) {
    // Release the minute so the next refusal is audited.
    if (recentRefusals.get(key) === entry) recentRefusals.delete(key)
    throw error
  }
}

export function gateByFlag(
  flag: FeatureFlag,
  handler: RouteHandler,
  isCoreRequest?: CoreRequestPredicate
): RouteHandler {
  return async (request, session) => {
    if (isFeatureEnabled(flag, session?.firmId)) return handler(request, session)
    if (isCoreRequest && (await isCoreRequest(request))) return handler(request, session)
    // A caller with no resolvable identity (insecure-dev only) has no firm to audit against.
    if (session) await auditRefusal(request, session, flag)
    return featureDisabledResponse(flag)
  }
}

/**
 * The live core of /api/d4/filings while LEGACY_GOVERNANCE_CHAINS is off: the v6
 * Module 12 package path that the existing tests cover (tests/api.filings.test.ts
 * "creates pending filing package and supports partner approval", "lists filing
 * packages with pagination and matter scoping", "filters filing packages by
 * readiness after partner approval", "blocks filing package creation when
 * preflight overruled gate fails"):
 *   POST action create_package (incl. the citation gate, the session-bound partnerOverride
 *        and its audit, the draft charset refusal, the stored judgment ids and the draft lock)
 *   POST action decide_package (partner approval, incl. the bodySha256 check against the
 *        durable draft, the judgment-id re-check at approval, the override audit and the
 *        draft lock/unlock)
 *   GET  the package list (no `view`, or view=packages)
 * fix/sec-gaps added no filings action or view: every approval-path check it added runs
 * inside these two actions, so the core list is unchanged.
 * Everything else (dispatch queue, annexures, submission/transport, escalation,
 * closure and settlement chains) is frozen.
 */
export const FILINGS_CORE_ACTIONS: readonly string[] = ["create_package", "decide_package"]
export const FILINGS_CORE_VIEWS: readonly string[] = ["packages"]

export async function isFilingsCoreRequest(request: Request): Promise<boolean> {
  if (request.method.toUpperCase() === "GET") {
    const view = new URL(request.url).searchParams.get("view")
    return !view || FILINGS_CORE_VIEWS.includes(view)
  }
  let action: unknown
  try {
    action = ((await request.clone().json()) as { action?: unknown } | null)?.action
  } catch {
    action = undefined
  }
  // No usable action: the handler's own validation answers (400) before any data is read.
  if (typeof action !== "string" || action === "") return true
  return FILINGS_CORE_ACTIONS.includes(action)
}
