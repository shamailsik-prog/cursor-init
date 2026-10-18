/**
 * Why an authority adapter could not answer (audit F05). Every failure of the corpus reader is one of these, from the
 * network to data that breaks the Annex A contract. The gate reads it as "not proven" (UNVERIFIED /
 * TEMPORAL_UNAVAILABLE), never OK. This module has no imports, so both the port (authority.ts, which re-exports it)
 * and the corpus adapter can use it without an import cycle.
 */
export const AUTHORITY_UNAVAILABLE_REASONS = Object.freeze([
  "unreachable",
  "timeout",
  "auth",
  "tls",
  "permission",
  "schema_missing",
  "contract_missing",
  "stale",
  "wrong_role",
  "pending_review",
  "inconsistent",
  "circuit_open",
  "busy",
  "budget",
  "error",
] as const)
export type AuthorityUnavailableReason = (typeof AUTHORITY_UNAVAILABLE_REASONS)[number]

/**
 * The one error an adapter throws when it cannot answer. The gate catches this class, and only this class: any other
 * error is a bug and still fails the request. The message is the reason token only, never driver text, a host or a
 * credential.
 */
export class AuthorityUnavailableError extends Error {
  readonly reason: AuthorityUnavailableReason

  constructor(reason: AuthorityUnavailableReason) {
    super(`authority_unavailable:${reason}`)
    this.name = "AuthorityUnavailableError"
    this.reason = reason
  }
}
