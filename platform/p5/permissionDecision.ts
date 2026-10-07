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
import { CLASSIFICATION_RANKS, type Classification } from "@/platform/p1/types";

export type PermissionDecision = { allow: boolean; reason: string };

/** The caller as the table needs it (role and clearance already resolved by the identity policy). */
export type DecisionCaller = {
  role: string;
  firmId: string;
  clearanceLevel: Classification;
};

/**
 * The named matter: `undefined` when the action names no matter, `null` when it names one that
 * does not exist (treated as cross-firm, so existence never leaks).
 */
export type DecisionMatter =
  | { firmId: string; classification: unknown }
  | null
  | undefined;

/** The only actions the accounts role may take (L17.6: getIntimationRegister, recordAccountsEntry). */
export const ACCOUNTS_REGISTER_ACTIONS: ReadonlySet<string> = new Set([
  "intimation_register",
  "record_accounts_entry",
]);

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
] as const;
export type FirmAdminAction = (typeof FIRM_ADMIN_ACTIONS)[number];
const FIRM_ADMIN_ACTION_SET: ReadonlySet<string> = new Set(FIRM_ADMIN_ACTIONS);

export function isFirmAdminAction(action: string): action is FirmAdminAction {
  return FIRM_ADMIN_ACTION_SET.has(action);
}

/**
 * Firm tools for staff (partner, associate, clerk, intern), never for a client (re-audit N-2):
 * `normalise_case_number` is POST /api/g0/normalise. Accounts keep their register-only rule.
 */
export const STAFF_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "normalise_case_number",
]);

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
] as const;
export type D1Action = (typeof D1_ACTIONS)[number];
const D1_ACTION_SET: ReadonlySet<string> = new Set(D1_ACTIONS);

export function isD1Action(action: string): action is D1Action {
  return D1_ACTION_SET.has(action);
}

const D1_STAFF = ["partner", "associate", "clerk", "intern"];
const D1_PARTNER_ASSOCIATE = ["partner", "associate"];
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
};
const D1_MATTER_LEVEL: ReadonlySet<string> = new Set([
  "matter.read",
  "matter.advance_stage",
  "matter.close",
]);

const deny = (reason: string): PermissionDecision => ({ allow: false, reason });
const allow = (reason: string): PermissionDecision => ({ allow: true, reason });

function knownRank(value: unknown): number | null {
  return typeof value === "string" && Object.hasOwn(CLASSIFICATION_RANKS, value)
    ? CLASSIFICATION_RANKS[value as Classification]
    : null;
}

export function decide(
  caller: DecisionCaller | null | undefined,
  action: string,
  matter: DecisionMatter,
  isMember: boolean,
  extra?: { scope?: "own_matters" },
): PermissionDecision {
  if (!caller) return deny("no-user");

  if (isFirmAdminAction(action)) {
    return caller.role === "partner" ? allow("ok") : deny("partner-only");
  }

  // L17.6 #41: "The accounts role is defined in L4.7 with read access to the intimation
  // register only — no matter documents." Membership does not widen it.
  if (caller.role === "accounts") {
    if (!ACCOUNTS_REGISTER_ACTIONS.has(action))
      return deny("accounts-register-only");
    if (matter !== undefined && (!matter || matter.firmId !== caller.firmId))
      return deny("cross-firm");
    return allow("accounts-register");
  }

  if (isD1Action(action)) {
    if (caller.role === "client" || extra?.scope === "own_matters")
      return deny("client-denied");
    if (D1_MATTER_LEVEL.has(action)) {
      // A matter-level action must name a matter; none given fails closed.
      if (!matter || matter.firmId !== caller.firmId) return deny("cross-firm");
      if (!isMember) return deny("not-member");
      const required = knownRank(matter.classification);
      const held = knownRank(caller.clearanceLevel);
      if (required === null || held === null || held < required)
        return deny("clearance");
    }
    return D1_ROLES[action].includes(caller.role)
      ? allow("ok")
      : deny("role-not-permitted");
  }

  if (
    caller.role === "intern" &&
    (action === "research" || action === "draft")
  ) {
    return deny("intern-channel-denied");
  }

  if (extra?.scope === "own_matters" || caller.role === "client") {
    if (STAFF_ONLY_ACTIONS.has(action)) return deny("staff-only");
    if (action === "research" || action === "draft")
      return deny("client-channel-denied");
    if (action === "list_matters") return allow("client-own-matters");
  }

  if (action === "list_matters") return allow("ok");

  if (matter !== undefined) {
    if (!matter || matter.firmId !== caller.firmId) return deny("cross-firm");
    if (!isMember) return deny("not-member");
    const required = knownRank(matter.classification);
    const held = knownRank(caller.clearanceLevel);
    if (required === null || held === null || held < required)
      return deny("clearance");
  }

  if (action === "research" && caller.role === "client")
    return deny("client-research-denied");

  return allow("ok");
}
