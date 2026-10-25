/**
 * P5 permission decision table (Layer 18 §4.5) — the one table both runtimes evaluate (I-3 /
 * U-2). Pure: no store, Firestore, Next.js or firebase imports. platform/p5/checkPermission.ts
 * (Next.js, in-memory store) and functions/src/p5/permission.ts (Cloud Functions, Firestore,
 * bundled through the "@/" alias) each read the caller, the matter and the membership their
 * own way, call `decide`, and audit the result.
 *
 * Rows, in order:
 *   - no caller                                  -> deny no-user
 *   - a firm-administration action (FIRM_ADMIN_ACTIONS: identity and MFA administration) or a
 *     retention action (RETENTION_ACTIONS, audit F42)  -> partner only (deny partner-only)
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
 *   - an accounts register action (ACCOUNTS_ACTIONS) by any role but accounts -> deny role-not-permitted
 *     (FA-F43-R1-P01: no route serves the register to staff yet)
 *   - a Next.js route action (NEXT_ROUTE_ACTIONS, FA-F43-R1-P01), in this order:
 *       intern research / draft                  -> deny intern-channel-denied
 *       a client or an own_matters scope: list_matters -> allow client-own-matters; a staff-only
 *       action (STAFF_ONLY_ACTIONS) -> deny staff-only; research / draft -> deny client-channel-denied;
 *       anything else -> deny client-denied
 *       the matter gate: the committee actions must name a matter; research, draft and
 *       normalise_case_number are gated when they name one; list_matters never is
 *       then the role table (NEXT_ROUTE_ROLES)   -> role-not-permitted
 *   - the matter gate (every matter-level row above): same firm (cross-firm), not tombstoned
 *     (matter-deleted, audit F42), a member (not-member), cleared for its classification
 *     (clearance; an unreadable classification is refused: fail closed).
 *   - otherwise                                  -> deny unknown-action (FA-F43-R1-P01: an action
 *     no row knows is refused, never allowed; DECIDE_ACTIONS lists every action a row decides, and
 *     G-0 [23], ci_gates/check_permission_actions.py, keeps every call site's action in it)
 */
import { CLASSIFICATION_RANKS, type Classification } from "@/platform/p1/types"

export type PermissionDecision = { allow: boolean; reason: string }

/** The caller as the table needs it (role and clearance already resolved by the identity policy). */
export type DecisionCaller = { role: string; firmId: string; clearanceLevel: Classification }

/**
 * The named matter: `undefined` when the action names no matter, `null` when it names one that
 * does not exist (treated as cross-firm, so existence never leaks). `deleted`: the matter has a
 * tombstone of its own firm (audit F42); a named matter of the caller's firm that is deleted is
 * refused `matter-deleted` before membership or clearance is considered.
 */
export type DecisionMatter = { firmId: string; classification: unknown; deleted?: boolean } | null | undefined

/**
 * The only actions the accounts role may take (L17.6: getIntimationRegister, recordAccountsEntry). Any other role is
 * refused them (role-not-permitted, FA-F43-R1-P01): no route serves the register to staff yet, and when one does
 * (L17.6 #40: "visible on the matter and in the dashboard") its roles are ruled then.
 */
export const ACCOUNTS_ACTIONS = ["intimation_register", "record_accounts_entry"] as const
export type AccountsAction = (typeof ACCOUNTS_ACTIONS)[number]
export const ACCOUNTS_REGISTER_ACTIONS: ReadonlySet<string> = new Set(ACCOUNTS_ACTIONS)

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
 * Audit F42: retention and deletion (functions/src/retention/ops.ts). Firm administration, partner only, firm level:
 * they name no matter here, so a hold or a status read still works after an approval has revoked every membership.
 * The operations add their own guards: the partner's clearance must reach the matter's label, and the approval (and a
 * hold's release) must come from a partner other than the one who requested (or placed) it.
 */
export const RETENTION_ACTIONS = [
  "retention.request_deletion",
  "retention.approve_deletion",
  "retention.read",
  "retention.hold.place",
  "retention.hold.release",
] as const
export type RetentionAction = (typeof RETENTION_ACTIONS)[number]
const RETENTION_ACTION_SET: ReadonlySet<string> = new Set(RETENTION_ACTIONS)

export function isRetentionAction(action: string): action is RetentionAction {
  return RETENTION_ACTION_SET.has(action)
}

/**
 * Firm tools for staff (partner, associate, clerk, intern), never for a client (re-audit N-2):
 * `normalise_case_number` is POST /api/g0/normalise. Accounts keep their register-only rule.
 */
export const STAFF_ONLY_ACTIONS: ReadonlySet<string> = new Set(["normalise_case_number"])

/**
 * FA-F43-R1-P01: the actions the Next.js routes pass to checkPermission, each decided by an explicit row (until this
 * audit all but list_matters reached the table's default `allow ok`). Roles and sources (spec
 * docs/superpowers/specs/2026-10-24-fa-f43-p01-unknown-action-deny-design.md, R2):
 *   - list_matters: every staff role; a client or an own_matters scope gets client-own-matters (unchanged). A listing:
 *     never matter-gated, scoped later by membership.
 *   - research: partner, associate, clerk (L18 §8 and L19.10: a client cannot research; an intern is refused
 *     intern-channel-denied as since Phase 1; the ops-reporting and court-ops routes refuse client, intern, accounts).
 *   - draft: partner, associate, clerk (P4-10: the same roles as the D4 draft actions; an intern intern-channel-denied).
 *   - normalise_case_number: partner, associate, clerk, intern (re-audit N-2; a client is staff-only).
 *   - committee_brain, committee_brain_read: partner, associate, clerk, matter-level (P3-70: as ai.call; the
 *     /api/p1/committee-brain route refuses client, intern and accounts before P5). A client or an own_matters scope is
 *     client-denied, as for every AI action.
 * research, draft and normalise_case_number are matter-level when they name a matter and firm-level otherwise.
 */
export const NEXT_ROUTE_ACTIONS = [
  "list_matters",
  "research",
  "draft",
  "normalise_case_number",
  "committee_brain",
  "committee_brain_read",
] as const
export type NextRouteAction = (typeof NEXT_ROUTE_ACTIONS)[number]
const NEXT_ROUTE_ACTION_SET: ReadonlySet<string> = new Set(NEXT_ROUTE_ACTIONS)

export function isNextRouteAction(action: string): action is NextRouteAction {
  return NEXT_ROUTE_ACTION_SET.has(action)
}

/** The committee-brain actions platform/p5/committeeScope.ts `canAccessMatter` takes. */
export type CommitteeBrainAction = "committee_brain" | "committee_brain_read"

const NEXT_ROUTE_ROLES: Record<NextRouteAction, readonly string[]> = {
  list_matters: ["partner", "associate", "clerk", "intern"],
  research: ["partner", "associate", "clerk"],
  draft: ["partner", "associate", "clerk"],
  normalise_case_number: ["partner", "associate", "clerk", "intern"],
  committee_brain: ["partner", "associate", "clerk"],
  committee_brain_read: ["partner", "associate", "clerk"],
}
/** Must name a matter; none given fails closed (cross-firm). */
const NEXT_ROUTE_MATTER_LEVEL: ReadonlySet<string> = new Set(["committee_brain", "committee_brain_read"])

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
 * accounts-register-only before this table. (Before FA-F43-R1-P01 an action no row knew fell through to `allow ok` for
 * every staff role; it is now refused unknown-action.) The operator's own route is not a table action: it needs the
 * `platformAdmin` claim.
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

/**
 * FA-F43-R1-P01: every action a row of `decide` decides. Any other string is refused unknown-action. The G-0 parity
 * gate (ci_gates/check_permission_actions.py, check [23]) parses this list and fails the build when a call site passes
 * an action that is not in it.
 */
export const DECIDE_ACTIONS = [
  ...FIRM_ADMIN_ACTIONS,
  ...RETENTION_ACTIONS,
  ...ACCOUNTS_ACTIONS,
  ...D1_ACTIONS,
  ...JOB_ACTIONS,
  ...ALERT_ACTIONS,
  ...AI_ACTIONS,
  ...DRAFT_ACTIONS,
  ...DOCTYPE_ACTIONS,
  ...NEXT_ROUTE_ACTIONS,
] as const
export type DecideAction = (typeof DECIDE_ACTIONS)[number]
const DECIDE_ACTION_SET: ReadonlySet<string> = new Set(DECIDE_ACTIONS)

export function isKnownAction(action: string): action is DecideAction {
  return DECIDE_ACTION_SET.has(action)
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
  // Audit F42: a tombstoned matter is refused at once, whatever membership or clearance remains.
  if (matter.deleted === true) return deny("matter-deleted")
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

  if (isFirmAdminAction(action) || isRetentionAction(action)) {
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

  // FA-F43-R1-P01: the accounts register is the accounts role's alone (the accounts row above returned for it).
  if (ACCOUNTS_REGISTER_ACTIONS.has(action)) return deny("role-not-permitted")

  if (isNextRouteAction(action)) {
    if (caller.role === "intern" && (action === "research" || action === "draft")) {
      return deny("intern-channel-denied")
    }
    if (extra?.scope === "own_matters" || caller.role === "client") {
      if (action === "list_matters") return allow("client-own-matters")
      if (STAFF_ONLY_ACTIONS.has(action)) return deny("staff-only")
      if (action === "research" || action === "draft") return deny("client-channel-denied")
      return deny("client-denied")
    }
    // A listing is never matter-gated; a committee action must name a matter (none fails closed); the others are
    // matter-level when they name one.
    if (action !== "list_matters" && (NEXT_ROUTE_MATTER_LEVEL.has(action) || matter !== undefined)) {
      const refused = matterGate(caller, matter, isMember)
      if (refused) return refused
    }
    return NEXT_ROUTE_ROLES[action].includes(caller.role) ? allow("ok") : deny("role-not-permitted")
  }

  // FA-F43-R1-P01: an action no row knows is refused, for every role (it was `allow ok`).
  return deny("unknown-action")
}
