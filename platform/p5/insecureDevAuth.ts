import { resolveAuthMode } from "@/platform/p5/session"

/** Thrown when insecure-dev-only identity helpers are invoked under firebase/production auth. */
export class InsecureDevAuthContextError extends Error {
  readonly code = "INSECURE_DEV_AUTH_CONTEXT_REQUIRED"

  constructor(detail: string) {
    super(detail)
    this.name = "InsecureDevAuthContextError"
  }
}

export function assertInsecureDevAuthContext(context: string): void {
  if (process.env.NODE_ENV === "production" || resolveAuthMode() === "firebase") {
    throw new InsecureDevAuthContextError(
      `${context} is only available when SIKANDER_AUTH_MODE=insecure-dev (not in production or firebase auth mode)`
    )
  }
}
