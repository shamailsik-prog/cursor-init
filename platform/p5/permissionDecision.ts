/**
 * P5 permission decision table (Layer 18 §4.5) — the one table both runtimes evaluate (I-3 /
 * U-2). Pure: no store, Firestore, Next.js or firebase imports. platform/p5/checkPermission.ts
 * (Next.js, in-memory store) and functions/src/p5/permission.ts (Cloud Functions, Firestore,
 * bundled through the "@/" alias) each read the caller, the matter and the membership their
 * own way, call `decide`, and audit the result.
 *
 * Rows, in order:
 *   - no caller                                  -> deny no-user
 *   - a firm-administration action (FIRM_ADMIN_ACTIONS: identity and MFA administration)
 *                                                -> partner only (deny partner-only)
 *   - accounts (L17.6 #41): only ACCOUNTS_REGISTER_ACTIONS, never matter documents, and a
 *     named matter must be in the caller's firm  -> deny accounts-register-only / cross-firm
 *   - a D1 action (D1_ACTIONS): client -> client-denied; matter-level ones need the matter
 *     (cross-firm / not-member / clearance); then the role table -> role-not-permitted
 *   - a job action (JOB_ACTIONS): client or own_matters -> client-denied; job.read naming a
 *     matter -> cross-firm / not-member / clearance; then the role table -> role-not-permitted
 *   - an alert action (ALERT_ACTIONS, audit F43): client or own_matters -> client-denied; then the
 *     role table (partner only) -> role-not-permitted
 *   - an AI action (AI_ACTIONS): client or own_matters -> client-denied; ai.call is matter-level
 *     (must name a matter: cross-firm / not-member / clearance); then the role table -> role-not-permitted
 *   - a D4 drafting action (DRAFT_ACTIONS: draft.create ... draft.approve) or doctype.read: client or
 *     own_matters -> client-denied; the draft actions are matter-level (cross-firm / not-member /
 *     clearance), doctype.read is firm-level; then the role table -> intern-channel-denied for an
 *     intern (as the legacy `draft` action), role-not-permitted otherwise
 *   - intern: no research / draft                -> deny intern-channel-denied
 *   - a staff-only action (STAFF_ONLY_ACTIONS) by a client or under an own_matters scope
 *                                                -> deny staff-only
 *   - client or own_matters scope: no research / draft; list_matters is own matters only
 *   - list_matters                               -> allow
 *   - a named matter: same firm (cross-firm), a member (not-member), cleared for its
 *     classification (clearance; an unreadable classification is refused: fail closed)
 *   - client research                            -> deny client-research-denied
 *   - otherwise                                  -> allow ok
 */
import { CLASSIFICATION_RANKS, type Classification } from "@/platform/p1/types"

export type PermissionDecision = { allow: boolean; reason: string }

/** The caller as the table needs it (role and clearance already resolved by the identity policy). */
export type DecisionCaller = { role: string; firmId: string; clearanceLevel: Classification }

/**
 * The named matter: `undefined` when the action names no matter, `null` when it names one that
 * does not exist (treated as cross-firm, so existence never leaks).
 */
export type DecisionMatter = { firmId: string; classification: unknown } | null | undefined

/** The only actions the accounts role may take (L17.6: getIntimationRegister, recordAccountsEntry). */
export const ACCOUNTS_REGISTER_ACTIONS: ReadonlySet<string> = new Set(["intimation_register", "record_accounts_entry"])

/**
 * Firm administration (P5 identity and E-19 MFA operations, Cloud Functions): partner only.
 * The operations keep their own extra guards (no self-change, the target's clearance at most
 * the caller's, never the last active partner).
 */
export const FIRM_ADMIN_ACTIONS = [
  "identity.manage_users",
  "identity.set_claims",
  "identity.deactivate",
  "mfa.enforce",
  "mfa.approve_disable",
] as const
export type FirmAdminAction = (typeof FIRM_ADMIN_ACTIONS)[number]
const FIRM_ADMIN_ACTION_SET: ReadonlySet<string> = new Set(FIRM_ADMIN_ACTIONS)

export function isFirmAdminAction(action: string): action is FirmAdminAction {
  return FIRM_ADMIN_ACTION_SET.has(action)
}

/**
 * Firm tools for staff (partner, associate, clerk, intern), never for a client (re-audit N-2):
 * `normalise_case_number` is POST /api/g0/normalise. Accounts keep their register-only rule.
 */
export const STAFF_ONLY_ACTIONS: ReadonlySet<string> = new Set(["normalise_case_number"])

/**
 * D1 (Phase 2a: clients, matters, conflict checks). Staff only; a client or an own_matters scope
 * is denied (client-denied) and accounts hit accounts-register-only before this table. Firm-level
 * actions name no matter; matter-level ones go through cross-firm / not-member / clearance first.
 */
export const D1_ACTIONS = [
  "client.register",
  "client.read",
  "matter.open",
  "matter.advance_stage",
  "matter.close",
  "conflict.run",
  "conflict.resolve_review",
  "conflict.waive",
  "conflict.read_trail",
  "firm.set_numbering",
  "matter.read",
  "entity.review",
  "entity.confirm",
  "entity.dispute",
  "entity.reject",
  "entity.unmerge",
] as const
export type D1Action = (typeof D1_ACTIONS)[number]
const D1_ACTION_SET: ReadonlySet<string> = new Set(D1_ACTIONS)

export function isD1Action(action: string): action is D1Action {
  return D1_ACTION_SET.has(action)
}

const D1_STAFF = ["partner", "associate", "clerk", "intern"]
const D1_PARTNER_ASSOCIATE = ["partner", "associate"]
const D1_ROLES: Record<D1Action, readonly string[]> = {
  "client.register": ["partner", "associate", "clerk"],
  "client.read": D1_STAFF,
  "matter.open": D1_PARTNER_ASSOCIATE,
  "matter.advance_stage": D1_PARTNER_ASSOCIATE,
  "matter.close": ["partner"],
  "conflict.run": D1_PARTNER_ASSOCIATE,
  "conflict.resolve_review": D1_PARTNER_ASSOCIATE,
  "conflict.waive": ["partner"],
  "conflict.read_trail": D1_PARTNER_ASSOCIATE,
  "firm.set_numbering": ["partner"],
  "matter.read": D1_STAFF,
  "entity.review": D1_PARTNER_ASSOCIATE,
  "entity.confirm": D1_PARTNER_ASSOCIATE,
  "entity.dispute": D1_PARTNER_ASSOCIATE,
  "entity.reject": ["partner"],
  "entity.unmerge": ["partner"],
}
const D1_MATTER_LEVEL: ReadonlySet<string> = new Set(["matter.read", "matter.advance_stage", "matter.close"])

/**
 * P2 job engine (Phase 3a, P3-11): read a job (partner, associate, clerk; matter-level when a
 * matter is named), read the firm queue (partner), requeue a dead-lettered job (partner,
 * associate) and cancel one (partner). Staff only; a client or an own_matters scope is denied
 * (client-denied) and accounts hit accounts-register-only before this table.
 */
export const JOB_ACTIONS = ["job.read", "job.queue", "job.retry", "job.cancel"] as const
export type JobAction = (typeof JOB_ACTIONS)[number]
const JOB_ACTION_SET: ReadonlySet<string> = new Set(JOB_ACTIONS)

export function isJobAction(action: string): action is JobAction {
  return JOB_ACTION_SET.has(action)
}

const JOB_ROLES: Record<JobAction, readonly string[]> = {
  "job.read": ["partner", "associate", "clerk"],
  "job.queue": ["partner"],
  "job.retry": ["partner", "associate"],
  "job.cancel": ["partner"],
}

/**
 * Operational alerts (audit F43): read the firm's alert worklist (`alert.read`) and acknowledge or resolve an alert
 * that has escalated to the firm's partners (`alert.ack`): partner only, firm-level (an alert carries references, never
 * matter text). Staff only; a client or an own_matters scope is denied (client-denied) and accounts hit
 * accounts-register-only before this table. Without these rows an unknown action would fall through to `allow ok`
 * for every staff role. The operator's own route is not a table action: it needs the `platformAdmin` claim.
 */
export const ALERT_ACTIONS = ["alert.read", "alert.ack"] as const
export type AlertAction = (typeof ALERT_ACTIONS)[number]
const ALERT_ACTION_SET: ReadonlySet<string> = new Set(ALERT_ACTIONS)

export function isAlertAction(action: string): action is AlertAction {
  return ALERT_ACTION_SET.has(action)
}

const ALERT_ROLES: Record<AlertAction, readonly string[]> = {
  "alert.read": ["partner"],
  "alert.ack": ["partner"],
}

/**
 * P1 AI gateway (Phase 3d, P3-70, P3-71, P3-66): make a committee-brain call on a matter (`ai.call`:
 * partner, associate, clerk; matter-level, so it must name a matter the caller is a cleared member of),
 * read the firm's AI usage (`ai.usage.read`), set its budget (`ai.budget.set`) and set its kill switch
 * (`ai.kill_switch.set`): partner only. Staff only; a client or an own_matters scope is denied
 * (client-denied) and accounts hit accounts-register-only before this table. The platform kill switch
 * is not a table action: it needs the `platformAdmin` claim, checked by its operation.
 */
export const AI_ACTIONS = ["ai.call", "ai.usage.read", "ai.budget.set", "ai.kill_switch.set"] as const
export type AiAction = (typeof AI_ACTIONS)[number]
const AI_ACTION_SET: ReadonlySet<string> = new Set(AI_ACTIONS)

export function isAiAction(action: string): action is AiAction {
  return AI_ACTION_SET.has(action)
}

const AI_ROLES: Record<AiAction, readonly string[]> = {
  "ai.call": ["partner", "associate", "clerk"],
  "ai.usage.read": ["partner"],
  "ai.budget.set": ["partner"],
  "ai.kill_switch.set": ["partner"],
}
const AI_MATTER_LEVEL: ReadonlySet<string> = new Set(["ai.call"])

/**
 * D4 drafting (Phase 4a, P4-10): create, edit, gate and read a draft (`draft.create`, `draft.edit`, `draft.gate`,
 * `draft.read`: partner, associate, clerk), override a gate result and approve a draft (`draft.override`,
 * `draft.approve`: partner). All six are matter-level: they must name a matter the caller is a cleared member of
 * (R-2: no role is exempt), so a partner who is not a member is refused. Staff only; a client or an own_matters
 * scope is denied (client-denied) and accounts hit accounts-register-only before this table. An intern stays
 * denied as the legacy `draft` action denies it (intern-channel-denied).
 */
export const DRAFT_ACTIONS = ["draft.create", "draft.edit", "draft.gate", "draft.read", "draft.override", "draft.approve"] as const
export type DraftAction = (typeof DRAFT_ACTIONS)[number]
const DRAFT_ACTION_SET: ReadonlySet<string> = new Set(DRAFT_ACTIONS)

export function isDraftAction(action: string): action is DraftAction {
  return DRAFT_ACTION_SET.has(action)
}

/** Reading the verified document-type catalogue (`doctype.read`): partner, associate, clerk. Firm-level: it names no matter. */
export const DOCTYPE_ACTIONS = ["doctype.read"] as const
export type DocTypeAction = (typeof DOCTYPE_ACTIONS)[number]
const DOCTYPE_ACTION_SET: ReadonlySet<string> = new Set(DOCTYPE_ACTIONS)

export function isDocTypeAction(action: string): action is DocTypeAction {
  return DOCTYPE_ACTION_SET.has(action)
}

const DRAFT_ROLES: Record<DraftAction | DocTypeAction, readonly string[]> = {
  "draft.create": ["partner", "associate", "clerk"],
  "draft.edit": ["partner", "associate", "clerk"],
  "draft.gate": ["partner", "associate", "clerk"],
  "draft.read": ["partner", "associate", "clerk"],
  "draft.override": ["partner"],
  "draft.approve": ["partner"],
  "doctype.read": ["partner", "associate", "clerk"],
}

const deny = (reason: string): PermissionDecision => ({ allow: false, reason })
const allow = (reason: string): PermissionDecision => ({ allow: true, reason })

function knownRank(value: unknown): number | null {
  return typeof value === "string" && Object.hasOwn(CLASSIFICATION_RANKS, value)
    ? CLASSIFICATION_RANKS[value as Classification]
    : null
}

/** A named matter: same firm, a member, cleared for its classification (unreadable: fail closed). */
function matterGate(caller: DecisionCaller, matter: DecisionMatter, isMember: boolean): PermissionDecision | null {
  if (!matter || matter.firmId !== caller.firmId) return deny("cross-firm")
  if (!isMember) return deny("not-member")
  const required = knownRank(matter.classification)
  const held = knownRank(caller.clearanceLevel)
  if (required === null || held === null || held < required) return deny("clearance")
  return null
}

export function decide(
  caller: DecisionCaller | null | undefined,
  action: string,
  matter: DecisionMatter,
  isMember: boolean,
  extra?: { scope?: "own_matters" }
): PermissionDecision {
  if (!caller) return deny("no-user")

  if (isFirmAdminAction(action)) {
    return caller.role === "partner" ? allow("ok") : deny("partner-only")
  }

  // L17.6 #41: "The accounts role is defined in L4.7 with read access to the intimation
  // register only — no matter documents." Membership does not widen it.
  if (caller.role === "accounts") {
    if (!ACCOUNTS_REGISTER_ACTIONS.has(action)) return deny("accounts-register-only")
    if (matter !== undefined && (!matter || matter.firmId !== caller.firmId)) return deny("cross-firm")
    return allow("accounts-register")
  }

  if (isD1Action(action)) {
    if (caller.role === "client" || extra?.scope === "own_matters") return deny("client-denied")
    // A matter-level action must name a matter; none given fails closed.
    if (D1_MATTER_LEVEL.has(action)) {
      const refused = matterGate(caller, matter, isMember)
      if (refused) return refused
    }
    return D1_ROLES[action].includes(caller.role) ? allow("ok") : deny("role-not-permitted")
  }

  if (isJobAction(action)) {
    if (caller.role === "client" || extra?.scope === "own_matters") return deny("client-denied")
    // job.read naming a matter is matter-level: same firm, member, cleared (R-2: no role exempt).
    if (action === "job.read" && matter !== undefined) {
      const refused = matterGate(caller, matter, isMember)
      if (refused) return refused
    }
    return JOB_ROLES[action].includes(caller.role) ? allow("ok") : deny("role-not-permitted")
  }

  if (isAlertAction(action)) {
    if (caller.role === "client" || extra?.scope === "own_matters") return deny("client-denied")
    return ALERT_ROLES[action].includes(caller.role) ? allow("ok") : deny("role-not-permitted")
  }

  if (isAiAction(action)) {
    if (caller.role === "client" || extra?.scope === "own_matters") return deny("client-denied")
    // A matter-level action must name a matter; none given fails closed.
    if (AI_MATTER_LEVEL.has(action)) {
      const refused = matterGate(caller, matter, isMember)
      if (refused) return refused
    }
    return AI_ROLES[action].includes(caller.role) ? allow("ok") : deny("role-not-permitted")
  }

  if (isDraftAction(action) || isDocTypeAction(action)) {
    if (caller.role === "client" || extra?.scope === "own_matters") return deny("client-denied")
    // A draft action is matter-level and must name a matter; none given fails closed. doctype.read is firm-level.
    if (isDraftAction(action)) {
      const refused = matterGate(caller, matter, isMember)
      if (refused) return refused
    }
    if (DRAFT_ROLES[action].includes(caller.role)) return allow("ok")
    return deny(caller.role === "intern" ? "intern-channel-denied" : "role-not-permitted")
  }

  if (caller.role === "intern" && (action === "research" || action === "draft")) {
    return deny("intern-channel-denied")
  }

  if (extra?.scope === "own_matters" || caller.role === "client") {
    if (STAFF_ONLY_ACTIONS.has(action)) return deny("staff-only")
    if (action === "research" || action === "draft") return deny("client-channel-denied")
    if (action === "list_matters") return allow("client-own-matters")
  }

  if (action === "list_matters") return allow("ok")

  if (matter !== undefined) {
    const refused = matterGate(caller, matter, isMember)
    if (refused) return refused
  }

  if (action === "research" && caller.role === "client") return deny("client-research-denied")

  return allow("ok")
}
