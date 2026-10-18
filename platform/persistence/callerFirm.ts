/** Thrown when a repository read/write is attempted without a non-empty caller firm id. */
export class CallerFirmRequiredError extends Error {
  readonly code = "CALLER_FIRM_REQUIRED"

  constructor(context?: string) {
    super(context ? `${context}: caller firmId is required` : "caller firmId is required")
    this.name = "CallerFirmRequiredError"
  }
}

/** Thrown when a firm-scoped update is denied or cannot apply (never returned as silent null). */
export class FirmScopedUpdateError extends Error {
  readonly code = "FIRM_SCOPED_UPDATE_FAILED"

  constructor(message: string) {
    super(message)
    this.name = "FirmScopedUpdateError"
  }
}

export function requireCallerFirmId(
  callerFirmId: string | undefined | null,
  context?: string
): string {
  const trimmed = typeof callerFirmId === "string" ? callerFirmId.trim() : ""
  if (!trimmed) {
    throw new CallerFirmRequiredError(context)
  }
  return trimmed
}
