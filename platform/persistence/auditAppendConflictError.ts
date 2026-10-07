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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    )
  }
  return value
}

/**
 * Value equality for audit rows (key order and undefined fields ignored). Re-appending an
 * identical row is an idempotent no-op (retries, overlapping write-through); only a row
 * whose content differs from the stored one is a conflict.
 */
export function auditRowsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}
