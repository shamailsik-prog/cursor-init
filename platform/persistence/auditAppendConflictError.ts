/**
 * Raised when an audit append reuses the id of an audit row that already exists.
 * The audit log is insert-only: existing rows are never replaced.
 */
export class AuditAppendConflictError extends Error {
  readonly code = "audit_append_conflict" as const
  readonly auditId: string

  constructor(auditId: string) {
    super(`audit entry ${auditId} already exists; the audit log is append-only`)
    this.name = "AuditAppendConflictError"
    this.auditId = auditId
  }
}
