import { onRequest } from "firebase-functions/v2/https"
import type { Request } from "firebase-functions/v2/https"
import type { Response } from "express"

export const REGION = "asia-south1"

/**
 * Pinned timeout for `api`. The idempotency lease
 * (http/idempotency.ts) must outlive it, or a slow but live request could be
 * taken over and run twice; that module asserts this when it loads.
 */
export const FUNCTION_TIMEOUT_SECONDS = 120

export function healthHandler(_req: Request, res: Response): void {
  res.status(200).json({ status: "ok", region: REGION })
}

// Region set here, not by setGlobalOptions in index.ts: that runs after this object is built (deploy.test).
export const health = onRequest({ region: REGION }, healthHandler)
