import { onRequest } from "firebase-functions/v2/https"
import type { Request } from "firebase-functions/v2/https"
import type { Response } from "express"
import { INGRESS_SETTINGS } from "./deployConfig"

export const REGION = "asia-south1"

/**
 * Pinned timeout for `api` and every callable. The idempotency lease
 * (http/idempotency.ts) must outlive it, or a slow but live request could be
 * taken over and run twice; that module asserts this when it loads.
 */
export const FUNCTION_TIMEOUT_SECONDS = 120

/** Options shared by every P5 callable: region, pinned timeout and the configured ingress. */
export const CALLABLE_OPTIONS = {
  region: REGION,
  timeoutSeconds: FUNCTION_TIMEOUT_SECONDS,
  ingressSettings: INGRESS_SETTINGS,
} as const

export function healthHandler(_req: Request, res: Response): void {
  res.status(200).json({ status: "ok", region: REGION })
}

export const health = onRequest(healthHandler)
