import { onRequest } from "firebase-functions/v2/https"
import type { Request } from "firebase-functions/v2/https"
import type { Response } from "express"

export const REGION = "asia-south1"

export function healthHandler(_req: Request, res: Response): void {
  res.status(200).json({ status: "ok", region: REGION })
}

export const health = onRequest(healthHandler)
